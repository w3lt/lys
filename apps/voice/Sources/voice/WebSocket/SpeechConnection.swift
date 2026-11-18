import Foundation
import Network

/// Wraps one WebSocket connection so it can cross task boundaries.
private struct ConnectionBox: @unchecked Sendable {
    /// The wrapped connection; Network.framework serializes its sends.
    let connection: NWConnection
}

/// One speech WebSocket connection accepted by ``SpeechSocketServer``.
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
/// a longer one fails the connection, so the client splits longer text.
/// A connection that completes no handshake within its handshake timeout is
/// cancelled, and a close waits at most ``pumpStopTimeout`` for audio still
/// being sent before it cancels the connection. Every failure is logged with
/// its cause.
///
/// Concurrency model: one task runs ``run()`` per connection; the receive
/// loop and the frame pump communicate through a lock-protected state, and
/// every wait on the connection happens outside it.
final class SpeechConnection: @unchecked Sendable {
    /// Result of routing a `text` message to the active session.
    private enum EnqueueOutcome {
        /// No speech is active on this connection.
        case noSpeech
        /// The client already sent `finish`.
        case afterFinish
        /// The sentence was queued on the session.
        case enqueued(any SpeechSession)
    }

    /// Shared PCM stream state, guarded by ``lock``.
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

    /// The accepted connection.
    private let box: ConnectionBox
    /// Engine that makes this connection's speech sessions.
    private let engine: any SpeechEngine
    /// The one active speech across every connection.
    private let hub: SpeechHub
    /// Longest wait for the client's WebSocket handshake.
    private let handshakeTimeout: Duration
    /// Guards ``state``.
    private let lock = NSLock()
    /// The speech this connection drives and its close state.
    private var state = State()

    /// Wraps an accepted connection that has not been started.
    ///
    /// - Parameters:
    ///   - connection: Accepted WebSocket connection.
    ///   - engine: Engine that makes the speech sessions.
    ///   - hub: The server's hub, which keeps one speech active at a time.
    ///   - handshakeTimeout: Longest wait for the client's WebSocket
    ///     handshake before the connection is cancelled.
    init(connection: NWConnection, engine: any SpeechEngine, hub: SpeechHub, handshakeTimeout: Duration) {
        self.box = ConnectionBox(connection: connection)
        self.engine = engine
        self.hub = hub
        self.handshakeTimeout = handshakeTimeout
    }

    /// Serves the connection until it closes; returns when it has closed.
    ///
    /// Cancelling the calling task cancels the socket, which ends a pending
    /// receive with an error.
    func run() async {
        await withTaskCancellationHandler {
            await self.serve()
        } onCancel: {
            self.box.connection.cancel()
        }
    }

    /// Receives messages until the peer closes or an error occurs.
    ///
    /// A receive failure before this side sent its close frame, such as a
    /// message over ``maximumMessageSize`` or a peer that went away without
    /// a close frame, is logged before the speech is torn down.
    private func serve() async {
        box.connection.start(queue: DispatchQueue(label: "voice.WebSocket"))
        let deadline = startHandshakeDeadline()
        defer { deadline.cancel() }
        while true {
            let message: Result<Message, any Error>
            do {
                message = .success(try await receiveMessage())
            } catch {
                message = .failure(error)
            }
            switch message {
            case .failure(let error):
                if !isCloseSent {
                    print("voice: speech connection \(box.connection.endpoint) failed: \(error)")
                }
                await teardown()
                return
            case .success(.close):
                await teardown()
                return
            case .success(.text(let body)):
                if !isCloseSent { await handleText(body) }
            case .success(.binary):
                if !isCloseSent { await initiateClose(.protocolCode(.unsupportedData)) }
            }
        }
    }

    /// Cancels the connection when its handshake has not completed within
    /// ``handshakeTimeout``, so an idle client cannot hold a place under the
    /// server's connection cap.
    ///
    /// - Returns: The deadline's task, which ``serve()`` owns and cancels
    ///   once the connection ended.
    private func startHandshakeDeadline() -> Task<Void, Never> {
        let box = self.box
        let timeout = handshakeTimeout
        return Task {
            try? await Task.sleep(for: timeout)
            guard !Task.isCancelled else { return }
            switch box.connection.state {
            case .setup, .waiting, .preparing:
                print("voice: speech connection \(box.connection.endpoint) completed no handshake within \(timeout)")
                box.connection.cancel()
            default:
                return
            }
        }
    }

    /// One decoded message, before protocol validation.
    private enum Message {
        /// A UTF-8 text message with its payload.
        case text(String)
        /// A binary message; the client never sends those.
        case binary
        /// The peer sent a close frame.
        case close
    }

    // MARK: - Message handling

    /// Routes one client text message; an undecodable one is a protocol
    /// error.
    ///
    /// - Parameter body: The message's UTF-8 text.
    private func handleText(_ body: String) async {
        guard let message = decodeSpeechMessage(body) else {
            await initiateClose(.protocolCode(.protocolError))
            return
        }
        switch message {
        case .speak:
            await beginSpeech()
        case .text(let sentence):
            await enqueueText(sentence)
        case .finish:
            await finishSpeech()
        }
    }

    /// Starts a new speech, superseding any speech this connection owns and,
    /// through the hub, any speech another connection owns.
    private func beginSpeech() async {
        // Close out any speech this connection already owned.
        await endSpeech()
        let session: any SpeechSession
        do {
            session = try await engine.makeSession()
        } catch {
            print("voice: could not start a speech session: \(error)")
            await initiateClose(.protocolCode(.internalServerError))
            return
        }
        let id = UUID()
        hub.begin(id: id) { [weak self] in
            // Superseded by a newer speech anywhere: close this socket with
            // the going-away close code and stop synthesizing.
            Task { await self?.superseded() }
        }
        lock.withLock {
            state.session = session
            state.speechID = id
            state.finishReceived = false
        }
        startPump(session: session, id: id)
    }

    /// Queues one sentence on the active speech. Text before `speak` or
    /// after `finish` is a protocol error.
    private func enqueueText(_ sentence: String) async {
        let outcome: EnqueueOutcome = lock.withLock {
            guard let session = state.session else { return .noSpeech }
            guard !state.finishReceived else { return .afterFinish }
            return .enqueued(session)
        }
        switch outcome {
        case .enqueued(let session):
            session.enqueue(sentence)
        case .noSpeech, .afterFinish:
            await initiateClose(.protocolCode(.protocolError))
        }
    }

    /// Signals the end of the text stream for the active speech.
    private func finishSpeech() async {
        let session = lock.withLock { () -> (any SpeechSession)? in
            guard let session = state.session else { return nil }
            state.finishReceived = true
            return session
        }
        guard let session else {
            await initiateClose(.protocolCode(.protocolError))
            return
        }
        session.finish()
    }

    /// Marks the session finished and closes the socket, normally or with
    /// the internal-error code; a failed speech's session is cancelled first,
    /// because a failed send leaves it running.
    ///
    /// - Parameters:
    ///   - id: Identity of the speech that ended; a superseded one is
    ///     ignored.
    ///   - failed: Whether synthesis or sending failed.
    private func completeSpeech(id: UUID, failed: Bool) async {
        let (isCurrent, session) = lock.withLock { () -> (Bool, (any SpeechSession)?) in
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
        hub.end(id)
        await initiateClose(failed ? .protocolCode(.internalServerError) : .protocolCode(.normalClosure))
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
                    try await self.send(PCMConversion.littleEndianPCM16(from: frame), opcode: .binary)
                }
                // A cancelled pump ends its frames early; the close that
                // cancelled it decides the close code.
                guard !Task.isCancelled else { return }
                await self.completeSpeech(id: id, failed: false)
            } catch {
                // A send that fails after this side closed the socket follows
                // from that close and is not a failure of its own.
                if !self.isCloseSent {
                    print("voice: speech \(id) failed: \(error)")
                }
                await self.completeSpeech(id: id, failed: true)
            }
        }
        // A pump that already completed its speech cleared the speech; its
        // handle is not stored, so a close never waits for the pump that
        // runs it.
        lock.withLock {
            if state.speechID == id { state.pumpTask = task }
        }
    }

    // MARK: - Supersede and close

    /// Closes the socket with going-away because a newer speech took over.
    private func superseded() async {
        await initiateClose(.protocolCode(.goingAway))
    }

    /// Whether a close frame was sent; the pump stops when it was.
    private var isCloseSent: Bool {
        lock.withLock { state.closeSent }
    }

    /// Sends a close frame and tears the speech down.
    ///
    /// No frame may follow a close frame, so the pump is stopped first: a
    /// frame already being sent finishes, and only then is the close frame
    /// sent. The socket stays open briefly so the peer can observe the close
    /// code: the receive loop returns on the peer's close or error, and a
    /// watchdog cancels the socket a grace period later if the peer never
    /// answers.
    ///
    /// - Parameter code: Close code the peer receives.
    private func initiateClose(_ code: NWProtocolWebSocket.CloseCode) async {
        let (sends, pump) = lock.withLock { () -> (Bool, Task<Void, Never>?) in
            if state.closeSent { return (false, nil) }
            state.closeSent = true
            let pump = state.pumpTask
            state.pumpTask = nil
            return (true, pump)
        }
        if let pump {
            pump.cancel()
            await waitForPump(pump)
        }
        if sends {
            try? await send(nil, opcode: .close, closeCode: code)
        }
        await endSpeech()
        scheduleSocketCancel()
    }

    /// Waits for a cancelled frame pump to end, cancelling the connection
    /// when it has not ended within ``pumpStopTimeout``.
    ///
    /// Cancelling the pump ends its wait for frames but not a send already
    /// pending towards a peer that stopped reading; cancelling the connection
    /// fails that send, so the pump ends and the close can proceed.
    ///
    /// - Parameter pump: The frame pump, already cancelled.
    private func waitForPump(_ pump: Task<Void, Never>) async {
        let box = self.box
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await pump.value }
            group.addTask {
                try? await Task.sleep(for: Self.pumpStopTimeout)
                guard !Task.isCancelled else { return }
                print("voice: speech connection \(box.connection.endpoint) took no audio for \(Self.pumpStopTimeout); cancelling it")
                box.connection.cancel()
            }
            await group.next()
            group.cancelAll()
        }
    }

    /// Cancels the socket after a grace period, so a peer that never answers
    /// the close frame does not hold the connection open forever.
    private func scheduleSocketCancel() {
        let box = self.box
        Task {
            try? await Task.sleep(for: .seconds(1))
            box.connection.cancel()
        }
    }

    /// Ends the speech and cancels the pump and the socket.
    ///
    /// Idempotent: running it twice cancels the socket again, which the
    /// framework tolerates. Does not send a close frame; use
    /// ``initiateClose(_:)`` for a close the peer should see.
    private func teardown() async {
        await endSpeech()
        box.connection.cancel()
    }

    /// Cancels the session and the pump and unregisters from the hub.
    private func endSpeech() async {
        let (session, pump, id) = lock.withLock {
            () -> ((any SpeechSession)?, Task<Void, Never>?, UUID?) in
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
            hub.end(id)
        }
    }

    // MARK: - Wire helpers

    /// Sends one frame; `nil` data with the close opcode sends a close frame.
    private func send(
        _ data: Data?,
        opcode: NWProtocolWebSocket.Opcode,
        closeCode: NWProtocolWebSocket.CloseCode? = nil
    ) async throws {
        let metadata = NWProtocolWebSocket.Metadata(opcode: opcode)
        if let closeCode {
            metadata.closeCode = closeCode
        }
        let context = NWConnection.ContentContext(identifier: "speech", metadata: [metadata])
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            box.connection.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            })
        }
    }

    /// Reads the next message; throws when the connection fails.
    private func receiveMessage() async throws -> Message {
        try await withCheckedThrowingContinuation { continuation in
            box.connection.receiveMessage { content, context, _, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata
                if metadata?.opcode == .close {
                    continuation.resume(returning: .close)
                    return
                }
                guard let content, !content.isEmpty else {
                    continuation.resume(throwing: ConnectionClosed())
                    return
                }
                if metadata?.opcode == .binary {
                    continuation.resume(returning: .binary)
                    return
                }
                guard let text = String(data: content, encoding: .utf8) else {
                    continuation.resume(throwing: TextNotUTF8())
                    return
                }
                continuation.resume(returning: .text(text))
            }
        }
    }
}

/// The peer closed the connection without a close frame, or sent an empty
/// message where a message was expected.
private struct ConnectionClosed: Error {}

/// The peer sent a text message that is not valid UTF-8.
private struct TextNotUTF8: Error {}
