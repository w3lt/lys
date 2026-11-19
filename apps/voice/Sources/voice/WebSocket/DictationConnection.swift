import Foundation
import Network
import Synchronization

/// One dictation WebSocket connection, from the `transcribe` message that
/// started it until it closes.
///
/// The client sends binary messages carrying raw 16 kHz mono 16-bit
/// little-endian PCM, whole samples each, and `{ "type": "stop" }` when no
/// more audio follows. The server answers with JSON text messages:
/// `{ "type": "partial", "text": "…" }` with the whole text so far whenever
/// it changed, and `{ "type": "final", "text": "…" }` after `stop`. It ends
/// the socket with a close frame: `1000` once the final text was sent,
/// `1001` when a newer dictation superseded this one, `1002` for a message
/// that breaks the protocol — a text message that is not `stop`, or audio
/// that is not whole samples — and `1011` when recognition failed or fell
/// too far behind the audio. Audio and a `stop` that arrive after the first
/// `stop` are dropped. A client message may carry at most ``SpeechConnection/maximumMessageSize``
/// bytes; a longer one fails the receive, and Network.framework closes the
/// socket with `1009` itself. The client cancels a dictation by closing the
/// socket. Every failure is logged with its cause, and neither audio nor
/// text is ever logged.
///
/// Concurrency model: one task runs ``handleMessages()`` per connection;
/// the receive loop and the update pump communicate through the state under
/// its `Mutex`, and every wait on the connection happens outside it.
final class DictationConnection: Sendable {
    /// What the receive loop and the update pump share, guarded by its
    /// `Mutex`.
    private struct State {
        /// The dictation this connection drives, until it ends.
        var session: DictationSession?
        /// Identity of the dictation, for the hub.
        var dictationID: UUID?
        /// Task sending the session's updates to the socket.
        var pumpTask: Task<Void, Never>?
        /// Whether a close frame was sent or the peer went away.
        var closeSent = false

        /// Forgets the dictation when it is the one named.
        ///
        /// - Parameter id: Identity of the dictation that ended.
        /// - Returns: Whether the dictation was this connection's, and its
        ///   session when it was.
        mutating func removeDictation(_ id: UUID) -> (isCurrent: Bool, session: DictationSession?) {
            guard dictationID == id else { return (false, nil) }
            let ended = session
            session = nil
            dictationID = nil
            pumpTask = nil
            return (true, ended)
        }

        /// Forgets the dictation, whichever it is.
        ///
        /// - Returns: The session, the pump, and the identity it had.
        mutating func removeDictation() -> (session: DictationSession?, pump: Task<Void, Never>?, id: UUID?) {
            let ended = (session, pumpTask, dictationID)
            session = nil
            pumpTask = nil
            dictationID = nil
            return ended
        }

        /// Records that the close frame is being sent.
        ///
        /// - Returns: Whether this call is the first, and the pump to stop
        ///   before the frame goes out.
        mutating func startClose() -> (sends: Bool, pump: Task<Void, Never>?) {
            if closeSent { return (false, nil) }
            closeSent = true
            let pump = pumpTask
            pumpTask = nil
            return (true, pump)
        }
    }

    /// Longest wait for the update pump once a close cancelled it. A send to
    /// a peer that stopped reading ends only when the connection is
    /// cancelled.
    static let pumpStopTimeout: Duration = .seconds(1)

    /// The accepted connection; Network.framework serializes its sends.
    private let connection: NWConnection
    /// Engine that makes this connection's dictation session.
    private let engine: DictationEngine
    /// The one active dictation across every connection.
    private let hub: JobHub
    /// The dictation this connection drives and its close state.
    private let state = Mutex(State())

    /// Wraps a started connection whose first message was `transcribe`.
    ///
    /// - Parameters:
    ///   - connection: Accepted WebSocket connection, already started.
    ///   - engine: Engine that makes the dictation session.
    ///   - hub: The server's hub, which keeps one dictation active at a time.
    init(connection: NWConnection, engine: DictationEngine, hub: JobHub) {
        self.connection = connection
        self.engine = engine
        self.hub = hub
    }

    /// Starts the dictation, then reads and handles the client's messages
    /// until the peer closes or a receive fails, and cancels the connection.
    /// Returns when it has closed.
    func handleMessages() async {
        startDictation()
        var isOpen = true
        while isOpen, let message = await readNextMessage() {
            switch message {
            case .close:
                isOpen = false
            case .binary(let audio):
                if !isCloseSent { await addAudio(audio) }
            case .text(let body):
                if !isCloseSent { await handleText(body) }
            }
        }
        cancelConnection()
    }

    /// Reads the next message.
    ///
    /// - Returns: The message, or `nil` once a receive failed. A failure
    ///   before this side sent its close frame, such as a message over the
    ///   size limit or a peer that went away without a close frame, is
    ///   logged.
    private func readNextMessage() async -> SocketMessage? {
        do {
            return try await connection.readSocketMessage()
        } catch {
            if !isCloseSent {
                print("voice: dictation connection \(connection.endpoint) failed: \(error)")
            }
            return nil
        }
    }

    // MARK: - Message handling

    /// Starts the dictation, superseding through the hub any dictation
    /// another connection owns.
    private func startDictation() {
        let id = UUID()
        hub.register(id: id) { [weak self] in
            // Superseded by a newer dictation: close this socket with the
            // going-away close code and stop listening.
            Task { await self?.startClose(.protocolCode(.goingAway)) }
        }
        let session = engine.startSession()
        state.withLock { state in
            state.dictationID = id
            state.session = session
            state.pumpTask = startPump(session: session, id: id)
        }
    }

    /// Queues one message of audio on the dictation. Audio that is not
    /// whole samples is a protocol error; audio that arrives after `stop`,
    /// or while the dictation is ending, is dropped.
    ///
    /// - Parameter audio: The binary message's payload.
    private func addAudio(_ audio: Data) async {
        guard let session = state.withLock({ state in state.session }) else { return }
        guard let samples = PCMConversion.parseLittleEndianPCM16(audio) else {
            await closeForProtocolViolation("sent audio that is not whole samples")
            return
        }
        session.addAudio(samples)
    }

    /// Routes one client text message: `stop` closes the dictation's audio,
    /// and anything else is a protocol error.
    ///
    /// - Parameter body: The message's UTF-8 text.
    private func handleText(_ body: String) async {
        guard parseDictationMessage(body) == .stop else {
            await closeForProtocolViolation("sent a text message that is not stop")
            return
        }
        state.withLock { state in state.session }?.closeAudio()
    }

    /// Clears the dictation and closes the socket, normally or with the
    /// internal-error code; a failed dictation's session is cancelled first,
    /// because a failed send leaves it running.
    ///
    /// - Parameters:
    ///   - id: Identity of the dictation that ended.
    ///   - failed: Whether recognition or sending failed.
    private func handleDictationCompleted(id: UUID, failed: Bool) async {
        let (isCurrent, session) = state.withLock { state in state.removeDictation(id) }
        guard isCurrent else { return }
        if failed {
            session?.cancel()
        }
        hub.remove(id)
        await startClose(failed ? .protocolCode(.internalServerError) : .protocolCode(.normalClosure))
    }

    // MARK: - Update pump

    /// Starts the task that sends the session's updates to the socket and
    /// closes it once the final text was sent.
    ///
    /// A recognition or send failure before the socket closed is logged with
    /// the dictation id and closes the socket with `1011`. Updates that end
    /// without a final text belong to a cancelled dictation, whose close
    /// already decided the close code.
    ///
    /// - Parameters:
    ///   - session: The dictation's session.
    ///   - id: Identity of the dictation, for the hub.
    /// - Returns: The pump. ``startDictation()`` keeps it in the state under
    ///   the lock it starts it in, so the pump reads a state that already
    ///   holds it.
    private func startPump(session: DictationSession, id: UUID) -> Task<Void, Never> {
        Task { [weak self] in
            await self?.sendUpdates(of: session, id: id)
        }
    }

    /// Sends the session's updates to the socket until the final text was
    /// sent, the pump was cancelled, the close frame went out, or a failure
    /// ended the dictation.
    ///
    /// - Parameters:
    ///   - session: The dictation's session.
    ///   - id: Identity of the dictation, for the hub.
    private func sendUpdates(of session: DictationSession, id: UUID) async {
        do {
            for try await update in session.updates {
                if Task.isCancelled || isCloseSent { return }
                try await connection.sendSocketMessage(buildDictationUpdateMessage(update), opcode: .text)
                if case .final = update {
                    await handleDictationCompleted(id: id, failed: false)
                }
            }
        } catch {
            // A send that fails after this side closed the socket follows
            // from that close and is not a failure of its own.
            if !isCloseSent {
                print("voice: dictation \(id) failed: \(error)")
            }
            await handleDictationCompleted(id: id, failed: true)
        }
    }

    // MARK: - Close

    /// Whether a close frame was sent; the pump stops when it was.
    private var isCloseSent: Bool {
        state.withLock { state in state.closeSent }
    }

    /// Logs a client message that breaks the dictation protocol, then closes
    /// the socket with the protocol-error code.
    ///
    /// - Parameter violation: What the client did, completing "dictation
    ///   connection …".
    private func closeForProtocolViolation(_ violation: String) async {
        print("voice: dictation connection \(connection.endpoint) \(violation); closing with protocolError")
        await startClose(.protocolCode(.protocolError))
    }

    /// Sends a close frame and tears the dictation down.
    ///
    /// No message may follow a close frame, so the pump is stopped first: a
    /// message already being sent finishes, and only then is the close frame
    /// sent. The socket stays open briefly so the peer can observe the close
    /// code: the receive loop returns on the peer's close or error, and a
    /// timer cancels the socket a grace period later if the peer never
    /// answers.
    ///
    /// - Parameter code: Close code the peer receives.
    private func startClose(_ code: NWProtocolWebSocket.CloseCode) async {
        let (sends, pump) = state.withLock { state in state.startClose() }
        if let pump {
            pump.cancel()
            await connection.waitForSender(pump, within: Self.pumpStopTimeout)
        }
        if sends {
            try? await connection.sendSocketMessage(nil, opcode: .close, closeCode: code)
        }
        cancelDictation()
        connection.startCancelTimer()
    }

    /// Ends the dictation and cancels the pump and the socket, without a
    /// close frame; ``startClose(_:)`` is for a close the peer should see.
    private func cancelConnection() {
        cancelDictation()
        connection.cancel()
    }

    /// Cancels the session and the pump and unregisters from the hub.
    private func cancelDictation() {
        let (session, pump, id) = state.withLock { state in state.removeDictation() }
        session?.cancel()
        pump?.cancel()
        if let id {
            hub.remove(id)
        }
    }
}
