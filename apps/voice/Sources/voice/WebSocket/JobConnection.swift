import Foundation
import Network

/// What the jobs of a connection work with: each kind's engine, and the hub
/// that keeps one job of the kind running.
struct VoiceJobs: Sendable {
    /// Engine that makes the speech sessions.
    let speechEngine: any SpeechEngine
    /// The one active speech across every connection.
    let speechHub: JobHub
    /// Engine that makes the dictation sessions.
    let dictationEngine: DictationEngine
    /// The one active dictation across every connection.
    let dictationHub: JobHub
}

/// One WebSocket connection accepted by ``SpeechSocketServer``, from its
/// start until it closes.
///
/// The connection's first message names its job: `{ "type": "transcribe" }`
/// starts a dictation, which a ``DictationConnection`` serves, and anything
/// else belongs to a speech, which a ``SpeechConnection`` serves from that
/// message on. A connection that completes no handshake within its handshake
/// timeout is cancelled, and one that ends before its first message is
/// logged as such: a refused handshake ends that way, and its refusal was
/// already logged with its reason.
///
/// Concurrency model: one task runs ``handleConnection()`` per connection;
/// the class holds no mutable state.
final class JobConnection: Sendable {
    /// The accepted connection.
    private let connection: NWConnection
    /// The engines and hubs of the jobs.
    private let jobs: VoiceJobs
    /// Longest wait for the client's WebSocket handshake.
    private let handshakeTimeout: Duration

    /// Wraps an accepted connection that has not been started.
    ///
    /// - Parameters:
    ///   - connection: Accepted WebSocket connection.
    ///   - jobs: The engines and hubs of the jobs.
    ///   - handshakeTimeout: Longest wait for the client's WebSocket
    ///     handshake before the connection is cancelled.
    init(connection: NWConnection, jobs: VoiceJobs, handshakeTimeout: Duration) {
        self.connection = connection
        self.jobs = jobs
        self.handshakeTimeout = handshakeTimeout
    }

    /// Handles an accepted connection from its start until it closes:
    /// starts it, reads its first message, and serves the job that message
    /// names. Returns when the connection has closed.
    ///
    /// Cancelling the calling task cancels the socket, which ends a pending
    /// receive with an error.
    func handleConnection() async {
        await withTaskCancellationHandler {
            self.connection.start(queue: DispatchQueue(label: "voice.WebSocket"))
            guard let first = await self.readFirstMessage() else {
                self.connection.cancel()
                return
            }
            await self.handleJob(startingWith: first)
        } onCancel: {
            self.connection.cancel()
        }
    }

    /// Reads the connection's first message, within the handshake timeout
    /// for the handshake before it.
    ///
    /// - Returns: The message, or `nil` when the connection ended before
    ///   it, which is logged with its cause.
    private func readFirstMessage() async -> SocketMessage? {
        let deadline = startHandshakeDeadline()
        defer { deadline.cancel() }
        do {
            return try await connection.readSocketMessage()
        } catch {
            print("voice: connection \(connection.endpoint) ended before it sent a message: \(error)")
            return nil
        }
    }

    /// Serves the job the first message names, until the connection closes.
    ///
    /// - Parameter first: The connection's first message.
    private func handleJob(startingWith first: SocketMessage) async {
        if case .text(let body) = first, parseDictationMessage(body) == .transcribe {
            let dictation = DictationConnection(
                connection: connection,
                engine: jobs.dictationEngine,
                hub: jobs.dictationHub
            )
            await dictation.handleMessages()
            return
        }
        let speech = SpeechConnection(connection: connection, engine: jobs.speechEngine, hub: jobs.speechHub)
        await speech.handleMessages(startingWith: first)
    }

    /// Cancels the connection when its handshake has not completed within
    /// ``handshakeTimeout``, so an idle client cannot hold a place under the
    /// server's connection cap.
    ///
    /// - Returns: The deadline's task, which ``readFirstMessage()`` owns
    ///   and cancels once the first read ended.
    private func startHandshakeDeadline() -> Task<Void, Never> {
        let connection = self.connection
        let timeout = handshakeTimeout
        return Task {
            try? await Task.sleep(for: timeout)
            guard !Task.isCancelled else { return }
            switch connection.state {
            case .setup, .waiting, .preparing:
                print("voice: connection \(connection.endpoint) completed no handshake within \(timeout)")
                connection.cancel()
            default:
                return
            }
        }
    }
}
