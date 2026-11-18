import Foundation
import Network
import Synchronization

/// Serves the speech WebSockets, one speech per connection.
///
/// Two guards run before any connection is accepted: a handshake that
/// carries an `Origin` header — every browser request does, the backend's
/// does not — is refused, so no web page can make voice speak; and a
/// handshake while the models are still loading is refused, because the
/// backend reports the refusal to the desktop as “voice is not ready”.
/// Refused handshakes get HTTP 400, which the browser surfaces as a failed
/// connection, never as a readable error. Every refusal is logged.
///
/// The server owns at most ``maxConnections`` connections; connections
/// accepted beyond the cap are dropped without a handshake response, and
/// each drop is logged. A connection that completes no handshake within
/// ``handshakeTimeout`` is cancelled, so idle clients cannot hold every place.
///
/// Concurrency model: serialized. The only mutable state, the count of live
/// connections, is guarded by its `Mutex`; the speech hub serializes the
/// one active speech the same way.
final class SpeechSocketServer: Sendable {
    /// Default most speech connections served at once.
    static let defaultMaxConnections = 16
    /// Default longest wait for a client's WebSocket handshake.
    static let defaultHandshakeTimeout: Duration = .seconds(10)

    /// Live accepted connections; the server stops accepting beyond its cap.
    private let liveConnections = Mutex(0)

    /// Speech engine backing the accepted connections.
    private let engine: any SpeechEngine
    /// The one active speech across every connection.
    private let hub = SpeechHub()
    /// Local address the listener binds.
    private let host: NWEndpoint.Host
    /// Local TCP port the listener binds.
    private let port: NWEndpoint.Port
    /// Most connections served at once.
    private let maxConnections: Int
    /// Longest wait for a client's WebSocket handshake.
    private let handshakeTimeout: Duration

    /// Creates a server that is not listening yet.
    ///
    /// - Parameters:
    ///   - engine: Speech engine backing the accepted connections.
    ///   - host: Local address to bind; loopback by default.
    ///   - port: TCP port to bind; 9091 by default.
    ///   - maxConnections: Most connections served at once; a connection
    ///     accepted beyond the cap is dropped without a handshake response.
    ///   - handshakeTimeout: Longest wait for a client's WebSocket handshake
    ///     before its connection is cancelled.
    init(
        engine: any SpeechEngine,
        host: NWEndpoint.Host = "127.0.0.1",
        port: NWEndpoint.Port = 9091,
        maxConnections: Int = SpeechSocketServer.defaultMaxConnections,
        handshakeTimeout: Duration = SpeechSocketServer.defaultHandshakeTimeout
    ) {
        self.engine = engine
        self.host = host
        self.port = port
        self.maxConnections = maxConnections
        self.handshakeTimeout = handshakeTimeout
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

    /// Decides whether a speech socket handshake is accepted.
    ///
    /// A handshake carrying an `Origin` header — every browser sends one; the
    /// backend's client does not — is refused so no web page can ask voice to
    /// speak. A handshake while the models are not loaded is refused; the
    /// backend reports the refusal to the desktop as voice not ready.
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
        let engine = self.engine
        websocket.setClientRequestHandler(DispatchQueue(label: "voice.WebSocketHandshake")) { _, headers in
            let isReady = engine.isReady
            let accept = Self.canAcceptHandshake(headers: headers, isReady: isReady)
            if !accept {
                let reason = isReady ? "it carries an Origin header" : "the models are not loaded"
                print("voice: refused a speech handshake: \(reason)")
            }
            return NWProtocolWebSocket.Response(status: accept ? .accept : .reject, subprotocol: nil)
        }
        let parameters = NWParameters.tcp
        parameters.defaultProtocolStack.applicationProtocols = [websocket]
        parameters.requiredLocalEndpoint = .hostPort(host: host, port: port)
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
            print("WebSocket speech listener ready")
        case .waiting(let error):
            print("WebSocket speech listener waiting: \(error)")
        case .failed(let error):
            continuation.yield(.failed(error))
            continuation.finish()
        case .cancelled:
            continuation.finish()
        @unknown default:
            print("WebSocket speech listener entered unknown state \(state)")
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
                let maxConnections = self.maxConnections
                let atCapacity = liveConnections.withLock { count -> Bool in
                    if count >= maxConnections { return true }
                    count += 1
                    return false
                }
                if atCapacity {
                    print("voice: dropped a speech connection: \(maxConnections) connections are already open")
                    connection.cancel()
                    continue
                }
                group.addTask {
                    defer { self.liveConnections.withLock { $0 -= 1 } }
                    let speech = SpeechConnection(
                        connection: connection,
                        engine: self.engine,
                        hub: self.hub,
                        handshakeTimeout: self.handshakeTimeout
                    )
                    await speech.run()
                }
            case .failed(let error):
                throw error
            }
        }
    }
}
