import Foundation
import Network
import Synchronization

/// One speech WebSocket connection, from its first message until it closes.
///
/// The client sends JSON text messages: `{ "type": "speak" }` to start a
/// speech (closing any older speech), `{ "type": "text", "text": "…" }` to
/// queue one sentence, and `{ "type": "finish" }` when no more text follows.
/// The server answers with binary messages carrying raw 24 kHz mono 16-bit
/// little-endian PCM, one message per 80 ms frame, and ends the socket with
/// a close frame: `1000` once everything enqueued was spoken, `1001` when a
/// newer speech superseded this one, `1002` for a protocol violation,
/// `1003` for a binary message from the client, and `1011` when synthesis
/// failed. A client message may carry at most ``maximumMessageSize`` bytes;
/// a longer one fails the receive, and Network.framework closes the socket
/// with `1009` itself, so the client splits longer text.
/// A close waits at most ``pumpStopTimeout`` for audio still being sent
/// before it cancels the connection. Every failure is logged with its cause.
///
/// Concurrency model: one task runs ``handleMessages(startingWith:)`` per
/// connection; the receive loop and the frame pump communicate through the
/// state under its `Mutex`, and every wait on the connection happens
/// outside it.
final class SpeechConnection: Sendable {
    /// Result of routing a `text` message to the active session.
    private enum EnqueueOutcome {
        /// No speech is active on this connection.
        case noSpeech
        /// The client already sent `finish`.
        case afterFinish
        /// The sentence was queued on the session.
        case enqueued(any SpeechSession)
    }

    /// Shared PCM stream state, guarded by its `Mutex`.
    private struct State {
        /// The speech this connection drives, once `speak` arrived.
        var session: (any SpeechSession)?
        /// Identity of the speech, for the speech hub.
        var speechID: UUID?
        /// Task forwarding the session's frames to the socket.
        var pumpTask: Task<Void, Never>?
        /// Whether a close frame was sent or the peer went away.
        var closeSent = false
        /// Whether `finish` was received, after which `text` is an error.
        var finishReceived = false
    }

    /// Most bytes a client text message may carry; sentences are short.
    static let maximumMessageSize = 16 * 1024

    /// Longest wait for the frame pump once a close cancelled it. A send to a
    /// peer that stopped reading ends only when the connection is cancelled.
    static let pumpStopTimeout: Duration = .seconds(1)

    /// The accepted connection; Network.framework serializes its sends.
    private let connection: NWConnection
    /// Engine that makes this connection's speech sessions.
    private let engine: any SpeechEngine
    /// The one active speech across every connection.
    private let hub: JobHub
    /// The speech this connection drives and its close state.
    private let state = Mutex(State())

    /// Wraps a started connection whose first message was read.
    ///
    /// - Parameters:
    ///   - connection: Accepted WebSocket connection, already started.
    ///   - engine: Engine that makes the speech sessions.
    ///   - hub: The server's hub, which keeps one speech active at a time.
    init(connection: NWConnection, engine: any SpeechEngine, hub: JobHub) {
        self.connection = connection
        self.engine = engine
        self.hub = hub
    }

    /// Handles the client's messages, from the connection's first one until
    /// the peer closes or a receive fails, then cancels the connection.
    /// Returns when it has closed.
    ///
    /// A message that breaks the speech protocol, a binary one among them,
    /// is logged and answered with its close code.
    ///
    /// - Parameter first: The connection's first message, already read.
    func handleMessages(startingWith first: SocketMessage) async {
        var next: SocketMessage? = first
        while let message = next {
            switch message {
            case .close:
                next = nil
            case .text(let body):
                if !isCloseSent { await handleText(body) }
                next = await readNextMessage()
            case .binary:
                if !isCloseSent {
                    await closeForProtocolViolation("sent a binary message", code: .unsupportedData)
                }
                next = await readNextMessage()
            }
        }
        await cancelConnection()
    }

    /// Reads the next message.
    ///
    /// - Returns: The message, or `nil` once a receive failed. A failure
    ///   before this side sent its close frame, such as a message over
    ///   ``maximumMessageSize`` or a peer that went away without a close
    ///   frame, is logged before the speech is torn down. So is a text
    ///   message that is not UTF-8: Network.framework fails its receive and
    ///   closes the socket with `1002` itself.
    private func readNextMessage() async -> SocketMessage? {
        do {
            return try await connection.readSocketMessage()
        } catch {
            if !isCloseSent {
                print("voice: speech connection \(connection.endpoint) failed: \(error)")
            }
            return nil
        }
    }

    // MARK: - Message handling

    /// Routes one client text message; an undecodable one is a protocol
    /// error.
    ///
    /// - Parameter body: The message's UTF-8 text.
    private func handleText(_ body: String) async {
        guard let message = parseSpeechMessage(body) else {
            await closeForProtocolViolation("sent a message that is not a speech message", code: .protocolError)
            return
        }
        switch message {
        case .speak:
            await startSpeech()
        case .text(let sentence):
            await addText(sentence)
        case .finish:
            await closeText()
        }
    }

    /// Starts a new speech, superseding any speech this connection owns and,
    /// through the hub, any speech another connection owns.
    ///
    /// The speech takes the hub when `speak` arrives, before its session
    /// starts, so the latest `speak` speaks however long each session takes
    /// to start. A session that starts after its speech was superseded or
    /// closed is cancelled.
    private func startSpeech() async {
        // Close out any speech this connection already owned.
        await cancelSpeech()
        let id = UUID()
        state.withLock { state in
            state.speechID = id
            state.finishReceived = false
        }
        hub.register(id: id) { [weak self] in
            // Superseded by a newer speech anywhere: close this socket with
            // the going-away close code and stop synthesizing.
            Task { await self?.handleSuperseded() }
        }
        let session: any SpeechSession
        do {
            session = try await engine.startSession()
        } catch {
            print("voice: could not start a speech session: \(error)")
            await startClose(.protocolCode(.internalServerError))
            return
        }
        let isCurrent = state.withLock { state -> Bool in
            guard state.speechID == id, !state.closeSent else { return false }
            state.session = session
            return true
        }
        guard isCurrent else {
            await session.cancel()
            return
        }
        startPump(session: session, id: id)
    }

    /// Queues one sentence on the active speech. Text before `speak` or
    /// after `finish` is a protocol error.
    private func addText(_ sentence: String) async {
        let outcome: EnqueueOutcome = state.withLock { state in
            guard let session = state.session else { return .noSpeech }
            guard !state.finishReceived else { return .afterFinish }
            return .enqueued(session)
        }
        switch outcome {
        case .enqueued(let session):
            session.addText(sentence)
        case .noSpeech:
            await closeForProtocolViolation("sent text before speak", code: .protocolError)
        case .afterFinish:
            await closeForProtocolViolation("sent text after finish", code: .protocolError)
        }
    }

    /// Signals the end of the text stream for the active speech.
    private func closeText() async {
        let session = state.withLock { state -> (any SpeechSession)? in
            guard let session = state.session else { return nil }
            state.finishReceived = true
            return session
        }
        guard let session else {
            await closeForProtocolViolation("sent finish before speak", code: .protocolError)
            return
        }
        session.closeText()
    }

    /// Marks the session finished and closes the socket, normally or with
    /// the internal-error code; a failed speech's session is cancelled first,
    /// because a failed send leaves it running.
    ///
    /// - Parameters:
    ///   - id: Identity of the speech that ended; a superseded one is
    ///     ignored.
    ///   - failed: Whether synthesis or sending failed.
    private func handleSpeechCompleted(id: UUID, failed: Bool) async {
        let (isCurrent, session) = state.withLock { state -> (Bool, (any SpeechSession)?) in
            guard state.speechID == id else { return (false, nil) }
            let session = state.session
            state.session = nil
            state.speechID = nil
            state.pumpTask = nil
            return (true, session)
        }
        guard isCurrent else { return }
        // A failed send leaves the session synthesizing for nobody.
        if failed, let session {
            await session.cancel()
        }
        hub.remove(id)
        await startClose(failed ? .protocolCode(.internalServerError) : .protocolCode(.normalClosure))
    }

    // MARK: - Frame pump

    /// Starts the task that forwards the session's frames to the socket and
    /// closes it when the speech ends.
    ///
    /// A synthesis or send failure before the socket closed is logged with
    /// the speech id and closes the socket with `1011`.
    ///
    /// - Parameters:
    ///   - session: The speech's session.
    ///   - id: Identity of the speech, for the hub.
    private func startPump(session: any SpeechSession, id: UUID) {
        let task = Task { [weak self] in
            guard let self else { return }
            do {
                for try await frame in session.frames {
                    if Task.isCancelled { return }
                    if self.isCloseSent { return }
                    try await self.connection.sendSocketMessage(PCMConversion.buildLittleEndianPCM16(from: frame), opcode: .binary)
                }
                // A cancelled pump ends its frames early; the close that
                // cancelled it decides the close code.
                guard !Task.isCancelled else { return }
                await self.handleSpeechCompleted(id: id, failed: false)
            } catch {
                // A send that fails after this side closed the socket follows
                // from that close and is not a failure of its own.
                if !self.isCloseSent {
                    print("voice: speech \(id) failed: \(error)")
                }
                await self.handleSpeechCompleted(id: id, failed: true)
            }
        }
        // A pump that already completed its speech cleared the speech; its
        // handle is not stored, so a close never waits for the pump that
        // runs it.
        state.withLock { state in
            if state.speechID == id { state.pumpTask = task }
        }
    }

    // MARK: - Supersede and close

    /// Closes the socket with going-away because a newer speech took over.
    private func handleSuperseded() async {
        await startClose(.protocolCode(.goingAway))
    }

    /// Whether a close frame was sent; the pump stops when it was.
    private var isCloseSent: Bool {
        state.withLock { state in state.closeSent }
    }

    /// Logs a client message that breaks the speech protocol, then closes the
    /// socket with the code that names the violation.
    ///
    /// - Parameters:
    ///   - violation: What the client did, completing "speech connection …".
    ///   - code: Close code the client receives.
    private func closeForProtocolViolation(
        _ violation: String,
        code: NWProtocolWebSocket.CloseCode.Defined
    ) async {
        print("voice: speech connection \(connection.endpoint) \(violation); closing with \(code)")
        await startClose(.protocolCode(code))
    }

    /// Sends a close frame and tears the speech down.
    ///
    /// No frame may follow a close frame, so the pump is stopped first: a
    /// frame already being sent finishes, and only then is the close frame
    /// sent. The socket stays open briefly so the peer can observe the close
    /// code: the receive loop returns on the peer's close or error, and a
    /// timer cancels the socket a grace period later if the peer never
    /// answers.
    ///
    /// - Parameter code: Close code the peer receives.
    private func startClose(_ code: NWProtocolWebSocket.CloseCode) async {
        let (sends, pump) = state.withLock { state -> (Bool, Task<Void, Never>?) in
            if state.closeSent { return (false, nil) }
            state.closeSent = true
            let pump = state.pumpTask
            state.pumpTask = nil
            return (true, pump)
        }
        if let pump {
            pump.cancel()
            await connection.waitForSender(pump, within: Self.pumpStopTimeout)
        }
        if sends {
            try? await connection.sendSocketMessage(nil, opcode: .close, closeCode: code)
        }
        await cancelSpeech()
        connection.startCancelTimer()
    }

    /// Ends the speech and cancels the pump and the socket.
    ///
    /// Idempotent: running it twice cancels the socket again, which the
    /// framework tolerates. Does not send a close frame; use
    /// ``startClose(_:)`` for a close the peer should see.
    private func cancelConnection() async {
        await cancelSpeech()
        connection.cancel()
    }

    /// Cancels the session and the pump and unregisters from the hub.
    private func cancelSpeech() async {
        let (session, pump, id) = state.withLock { state -> ((any SpeechSession)?, Task<Void, Never>?, UUID?) in
            let values = (state.session, state.pumpTask, state.speechID)
            state.session = nil
            state.pumpTask = nil
            state.speechID = nil
            return values
        }
        if let session {
            await session.cancel()
        }
        pump?.cancel()
        if let id {
            hub.remove(id)
        }
    }
}
