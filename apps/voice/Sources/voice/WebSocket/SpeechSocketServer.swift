import Foundation
import Network
import Synchronization

/// Serves voice's WebSockets, one speech or one dictation per connection.
///
/// The class keeps the name it had while it served speech only: the
/// handbook's record of where voice's socket address is declared, and the
/// test that guards that address, both name this class and this file.
///
/// Two guards run before any connection is accepted: a handshake that
/// carries an `Origin` header — every browser request does, the backend's
/// does not — is refused, so no web page can make voice speak or listen;
/// and a handshake while the models are still loading is refused, because
/// the backend reports the refusal to the desktop as “voice is not ready”.
/// Refused handshakes get HTTP 400, which the browser surfaces as a failed
/// connection, never as a readable error. Every refusal is logged.
///
/// The server owns at most ``ListenerSettings/maxConnections`` connections;
/// connections accepted beyond the cap are dropped without a handshake
/// response, and each drop is logged. A connection that completes no
/// handshake within ``ListenerSettings/handshakeTimeout`` is cancelled, so
/// idle clients cannot hold every place.
///
/// Concurrency model: serialized. The only mutable state, the count of live
/// connections, is guarded by its `Mutex`; each job hub serializes the one
/// active job of its kind the same way.
final class SpeechSocketServer: Sendable {
    /// Where the server listens and how many clients it serves.
    struct ListenerSettings: Sendable {
        /// Local address the listener binds.
        var host: NWEndpoint.Host
        /// Local TCP port the listener binds.
        var port: NWEndpoint.Port
        /// Most connections served at once; a connection accepted beyond
        /// the cap is dropped without a handshake response.
        var maxConnections = SpeechSocketServer.defaultMaxConnections
        /// Longest wait for a client's WebSocket handshake before its
        /// connection is cancelled.
        var handshakeTimeout = SpeechSocketServer.defaultHandshakeTimeout
    }

    /// Default most connections served at once.
    static let defaultMaxConnections = 16
    /// Default longest wait for a client's WebSocket handshake.
    static let defaultHandshakeTimeout: Duration = .seconds(10)

    /// Live accepted connections; the server stops accepting beyond its cap.
    private let liveConnections = Mutex(0)

    /// The engines and hubs the accepted connections' jobs work with.
    private let jobs: VoiceJobs
    /// Where the server listens and how many clients it serves.
    private let settings: ListenerSettings

    /// Creates a server that is not listening yet.
    ///
    /// - Parameters:
    ///   - jobs: The speech and dictation engines backing the connections,
    ///     with the hubs that keep one job of each kind running.
    ///   - settings: Where the server listens and how many clients it
    ///     serves; loopback on port 9091 with the default limits by default.
    init(
        jobs: VoiceJobs,
        settings: ListenerSettings = ListenerSettings(host: "127.0.0.1", port: 9091)
    ) {
        self.jobs = jobs
        self.settings = settings
    }

    /// Listens and serves connections until the calling task is cancelled or
    /// the listener fails.
    ///
    /// - Parameter onReady: Called once with the bound port when the listener
    ///   is ready to accept connections. Tests use it to synchronize and to
    ///   learn the port the system chose for port 0.
    /// - Throws: The listener's `NWError` when it cannot be created or
    ///   fails; accepted connections are cancelled before the error is thrown.
    func start(onReady: (@Sendable (NWEndpoint.Port) -> Void)? = nil) async throws {
        guard !Task.isCancelled else { return }
        let listener = try createListener()
        let (events, continuation) = AsyncStream.makeStream(of: ListenerEvent.self)
        defer {
            listener.cancel()
            continuation.finish()
        }
        listener.stateUpdateHandler = { [weak listener] state in
            if case .ready = state, let port = listener?.port {
                onReady?(port)
            }
            Self.handleListenerStateUpdate(state, continuation: continuation)
        }
        listener.newConnectionHandler = { connection in
            continuation.yield(.accepted(connection))
        }
        listener.start(queue: DispatchQueue(label: "voice.WebSocketListener"))
        try await withThrowingDiscardingTaskGroup { group in
            try await addConnections(from: events, to: &group)
        }
    }

    // MARK: - Listener

    /// Listener callbacks, delivered to the serving loop in order.
    private enum ListenerEvent: Sendable {
        /// The listener accepted a connection that has not been started.
        case accepted(NWConnection)
        /// The listener failed; no event follows.
        case failed(NWError)
    }

    /// Decides whether a socket handshake is accepted.
    ///
    /// A handshake carrying an `Origin` header — every browser sends one; the
    /// backend's client does not — is refused so no web page can ask voice to
    /// speak or to listen. A handshake while the models are not loaded is
    /// refused; the backend reports the refusal to the desktop as voice not
    /// ready.
    static func canAcceptHandshake(headers: [(name: String, value: String)], isReady: Bool) -> Bool {
        guard isReady else { return false }
        return !headers.contains(where: { $0.name.lowercased() == "origin" })
    }

    /// Builds the WebSocket listener.
    ///
    /// The protocol stack is a single WebSocket layer; the handshake is
    /// rejected in the client-request handler, and the refusal logged, when
    /// the peer sent an `Origin` header or the models are not loaded yet.
    ///
    /// - Returns: A listener that has not been started.
    /// - Throws: `NWError` when Network.framework rejects the parameters.
    private func createListener() throws -> NWListener {
        let websocket = NWProtocolWebSocket.Options()
        websocket.autoReplyPing = true
        websocket.maximumMessageSize = SpeechConnection.maximumMessageSize
        let jobs = self.jobs
        websocket.setClientRequestHandler(DispatchQueue(label: "voice.WebSocketHandshake")) { _, headers in
            let isReady = jobs.speechEngine.isReady && jobs.dictationEngine.isReady
            let accept = Self.canAcceptHandshake(headers: headers, isReady: isReady)
            if !accept {
                let reason = isReady ? "it carries an Origin header" : "the models are not loaded"
                print("voice: refused a socket handshake: \(reason)")
            }
            return NWProtocolWebSocket.Response(status: accept ? .accept : .reject, subprotocol: nil)
        }
        let parameters = NWParameters.tcp
        parameters.defaultProtocolStack.applicationProtocols = [websocket]
        parameters.requiredLocalEndpoint = .hostPort(host: settings.host, port: settings.port)
        parameters.allowLocalEndpointReuse = true
        return try NWListener(using: parameters)
    }

    /// Reports a listener state change.
    ///
    /// - Parameters:
    ///   - state: New listener state.
    ///   - continuation: Producer side of the serving loop's event stream.
    private static func handleListenerStateUpdate(
        _ state: NWListener.State,
        continuation: AsyncStream<ListenerEvent>.Continuation
    ) {
        switch state {
        case .setup:
            break
        case .ready:
            print("WebSocket listener ready")
        case .waiting(let error):
            print("WebSocket listener waiting: \(error)")
        case .failed(let error):
            continuation.yield(.failed(error))
            continuation.finish()
        case .cancelled:
            continuation.finish()
        @unknown default:
            print("WebSocket listener entered unknown state \(state)")
        }
    }

    /// Serves accepted connections, one task each, until the event stream ends.
    ///
    /// - Parameters:
    ///   - events: Listener events in the order they occurred.
    ///   - group: Group that owns the connection tasks.
    /// - Throws: The listener's `NWError` when it fails.
    private func addConnections(
        from events: AsyncStream<ListenerEvent>,
        to group: inout ThrowingDiscardingTaskGroup<any Error>
    ) async throws {
        for await event in events {
            switch event {
            case .accepted(let connection):
                let maxConnections = settings.maxConnections
                let atCapacity = liveConnections.withLock { count -> Bool in
                    if count >= maxConnections { return true }
                    count += 1
                    return false
                }
                if atCapacity {
                    print("voice: dropped a connection: \(maxConnections) connections are already open")
                    connection.cancel()
                    continue
                }
                group.addTask {
                    defer { self.liveConnections.withLock { $0 -= 1 } }
                    let accepted = JobConnection(
                        connection: connection,
                        jobs: self.jobs,
                        handshakeTimeout: self.settings.handshakeTimeout
                    )
                    await accepted.handleConnection()
                }
            case .failed(let error):
                throw error
            }
        }
    }
}
