import Foundation
import Network

/// Listener callbacks, delivered to the serving loop in the order the listener
/// reported them.
private enum ListenerEvent: Sendable {
    /// The listener accepted a connection that has not been started.
    case connectionAccepted(NWConnection)
    /// The listener stopped because of an error. No event follows it.
    case listenerFailed(NWError)
}

/// Result of waiting for a request head against its deadline.
private enum RequestHeadWait: Sendable {
    /// The head arrived in time.
    case head(Data)
    /// The deadline passed first.
    case timedOut
}

/// Limits how many connections a server serves at once; extra connections
/// are closed as soon as they arrive. Guards the loopback listener against a
/// client queueing more connections than the process can serve.
///
/// Concurrency model: serialized. Every read and write of the free slot
/// count happens under ``lock``, so connection tasks may take and release
/// slots from any thread.
private final class ConnectionSlots: @unchecked Sendable {
    /// Slots not taken by an open connection.
    private var available: Int
    /// Guards ``available``.
    private let lock = NSLock()

    /// - Parameter limit: Most connections served at once.
    init(limit: Int) {
        self.available = limit
    }

    /// Takes one slot, or returns `false` when none is free.
    func addConnection() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard available > 0 else { return false }
        available -= 1
        return true
    }

    /// Releases one slot.
    func removeConnection() {
        lock.lock()
        available += 1
        lock.unlock()
    }
}

/// Owns a router and a local TCP address to serve HTTP/1.1 there, while
/// answering each connection's one request through the router and closing every
/// connection it accepts.
///
/// Every connection carries one request and one response, then closes.
/// Concurrency model: reentrant. The server has no mutable state; each
/// ``start(onReady:)`` call owns its own listener, connection tasks, and
/// connection slots.
final class WebServer: Sendable {
    /// Default maximum connections served at once.
    static let defaultMaxConnections = 32
    /// Default longest wait for a request head, in seconds.
    static let defaultHeadTimeout: Duration = .seconds(5)
    /// Routes that answer requests.
    private let router: Router
    /// Local address the listener binds.
    private let host: NWEndpoint.Host
    /// Local TCP port the listener binds.
    private let port: NWEndpoint.Port
    /// Most connections served at once.
    private let maxConnections: Int
    /// Longest wait for a request head before the connection is answered
    /// with `408`.
    private let headTimeout: Duration

    /// Creates a server that is not listening yet.
    ///
    /// The default host and port are voice's loopback HTTP address.
    ///
    /// - Parameters:
    ///   - router: Routes that answer requests.
    ///   - host: Local address to bind. Defaults to the IPv4 loopback address,
    ///     so only this machine can connect.
    ///   - port: TCP port to bind. Defaults to 9090.
    ///   - maxConnections: Most connections served at once; a connection
    ///     accepted beyond the cap is closed without a response.
    ///   - headTimeout: Longest wait for a request head before the connection
    ///     is answered with `408 Request Timeout` and closed.
    init(
        router: Router,
        host: NWEndpoint.Host = "127.0.0.1",
        port: NWEndpoint.Port = 9090,
        maxConnections: Int = WebServer.defaultMaxConnections,
        headTimeout: Duration = WebServer.defaultHeadTimeout
    ) {
        self.router = router
        self.host = host
        self.port = port
        self.maxConnections = maxConnections
        self.headTimeout = headTimeout
    }

    /// Starts listening and serves connections until the calling task is
    /// cancelled or the listener fails.
    ///
    /// Connections are served concurrently, one child task each. After
    /// cancellation the call cancels every open connection, waits for their
    /// tasks to end, and returns normally. It returns at once when the task is
    /// already cancelled.
    ///
    /// - Parameter onReady: Called once with the bound port when the listener
    ///   is ready to accept connections. Tests use it to synchronize and to
    ///   learn the port the system chose for port 0.
    /// - Throws: The listener's `NWError` when it cannot be created or fails,
    ///   for example because the port is in use. Open connections are
    ///   cancelled and their tasks have ended before the error is thrown.
    func start(onReady: (@Sendable (NWEndpoint.Port) -> Void)? = nil) async throws {
        guard !Task.isCancelled else {
            return
        }
        let listener = try buildListener()
        let (events, continuation) = AsyncStream.makeStream(of: ListenerEvent.self)
        defer {
            listener.cancel()
            continuation.finish()
        }
        listener.stateUpdateHandler = { [weak listener] state in
            if case .ready = state, let port = listener?.port {
                onReady?(port)
            }
            self.handleListenerStateUpdate(state, continuation: continuation)
        }
        listener.newConnectionHandler = { connection in
            handleListenerNewConnection(connection, continuation: continuation)
        }
        listener.start(queue: DispatchQueue(label: "WebServer.Listener"))
        let slots = ConnectionSlots(limit: maxConnections)
        try await withThrowingDiscardingTaskGroup { group in
            try await addConnectionTasks(from: events, to: &group, slots: slots)
        }
    }

    /// Builds a TCP listener bound to exactly this server's host and port.
    ///
    /// The port is given only through the required local endpoint, because
    /// Network.framework rejects a listener that also receives it separately.
    ///
    /// - Returns: A listener that has not been started.
    /// - Throws: `NWError` when Network.framework rejects the parameters.
    private func buildListener() throws -> NWListener {
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        parameters.requiredLocalEndpoint = .hostPort(host: host, port: port)
        return try NWListener(using: parameters)
    }

    /// Reports a listener state change.
    ///
    /// Runs on the listener queue. Failure and cancellation finish the event
    /// stream, so the serving loop stops after the events already delivered.
    ///
    /// - Parameters:
    ///   - state: New listener state.
    ///   - continuation: Producer side of the serving loop's event stream.
    private func handleListenerStateUpdate(
        _ state: NWListener.State,
        continuation: AsyncStream<ListenerEvent>.Continuation
    ) {
        switch state {
        case .setup:
            break // Initial state before the listener starts; nothing to report.
        case .ready:
            print("WebServer listening on \(host):\(port)")
        case .waiting(let error):
            print("WebServer waiting to listen on \(host):\(port): \(error)")
        case .failed(let error):
            continuation.yield(.listenerFailed(error))
            continuation.finish()
        case .cancelled:
            continuation.finish()
        @unknown default:
            print("WebServer listener entered unknown state \(state)")
        }
    }

    /// Adds one child task per accepted connection until the event stream ends.
    ///
    /// The stream ends when the calling task is cancelled or the listener is
    /// cancelled. Connections already buffered in the stream still get a task;
    /// in a cancelled group that task cancels its connection at once. Each
    /// connection takes its slot here, in the order the listener accepted
    /// them; a connection beyond the cap is closed at once and the drop is
    /// logged.
    ///
    /// - Parameters:
    ///   - events: Listener events in the order they occurred.
    ///   - group: Group that owns the connection tasks.
    ///   - slots: Limiter shared by every connection task.
    /// - Throws: The listener's `NWError` when it fails.
    private func addConnectionTasks(
        from events: AsyncStream<ListenerEvent>,
        to group: inout ThrowingDiscardingTaskGroup<any Error>,
        slots: ConnectionSlots
    ) async throws {
        for await event in events {
            switch event {
            case .connectionAccepted(let connection):
                guard slots.addConnection() else {
                    print("WebServer dropped connection \(connection.endpoint): \(maxConnections) connections are already open")
                    connection.cancel()
                    continue
                }
                group.addTask {
                    defer { slots.removeConnection() }
                    await self.handleConnection(connection)
                }
            case .listenerFailed(let error):
                throw error
            }
        }
    }

    /// Serves one accepted connection from start to close.
    ///
    /// The connection is cancelled on every path. Task cancellation cancels
    /// it at once, which ends a pending read or send. Failures are logged
    /// here because no caller can act on them: the connection is already
    /// lost.
    ///
    /// - Parameter connection: Accepted connection that has not been started.
    private func handleConnection(_ connection: NWConnection) async {
        connection.start(queue: DispatchQueue(label: "WebServer.Connection"))
        defer { connection.cancel() }
        do {
            try await withTaskCancellationHandler {
                try await handleRequest(on: connection)
            } onCancel: {
                connection.cancel()
            }
        } catch {
            print("WebServer connection \(connection.endpoint) failed: \(error)")
        }
    }

    /// Reads the connection's request and sends the one response for it.
    ///
    /// A request that cannot reach a route gets the matching error response.
    /// A head that does not arrive within ``headTimeout`` is logged, answered
    /// with `408`, and the connection is cancelled.
    ///
    /// - Parameter connection: Started connection whose request has not been
    ///   read.
    /// - Throws: The connection's `NWError` when receiving or sending fails.
    private func handleRequest(on connection: NWConnection) async throws {
        do {
            guard case .head(let head) = try await readRequestHead(on: connection) else { return }
            let request = try HTTPRequest(parsingHead: head)
            let response = await router.handleRequest(request)
            try await connection.sendResponse(response)
        } catch let error as HTTPRequestError {
            try await connection.sendResponse(HTTPResponse(requestError: error))
        }
    }

    /// Reads the request head, waiting at most ``headTimeout`` for it.
    ///
    /// Task cancellation cannot end a pending read, so at the deadline this
    /// logs the timeout, answers `408 Request Timeout`, and cancels the
    /// connection, which ends the read; only then does it return. The timeout
    /// is logged before the answer, so it stays on record when sending the
    /// `408` fails because the peer is gone.
    ///
    /// - Parameter connection: Started connection whose request has not been
    ///   read.
    /// - Returns: The head, or ``RequestHeadWait/timedOut`` once the timeout
    ///   was answered and the connection cancelled.
    /// - Throws: Whatever ``NWConnection/readRequestHead()`` throws when the
    ///   read fails first; the connection's `NWError` when sending the `408`
    ///   fails.
    private func readRequestHead(on connection: NWConnection) async throws -> RequestHeadWait {
        try await withThrowingTaskGroup(of: RequestHeadWait.self) { group in
            group.addTask { .head(try await connection.readRequestHead()) }
            group.addTask {
                try await Task.sleep(for: self.headTimeout)
                return .timedOut
            }
            defer { group.cancelAll() }
            guard case .head(let head) = try await group.next() else {
                defer { connection.cancel() }
                print("WebServer connection \(connection.endpoint) sent no request head within \(self.headTimeout)")
                try await connection.sendResponse(HTTPResponse(requestError: .requestHeadTimeout))
                return .timedOut
            }
            return .head(head)
        }
    }
}

/// Passes a connection the listener accepted to the serving loop, or cancels
/// it when the loop has already ended.
///
/// Runs on the listener queue.
///
/// - Parameters:
///   - connection: Accepted connection that has not been started.
///   - continuation: Producer side of the serving loop's event stream.
private func handleListenerNewConnection(
    _ connection: NWConnection,
    continuation: AsyncStream<ListenerEvent>.Continuation
) {
    if case .terminated = continuation.yield(.connectionAccepted(connection)) {
        connection.cancel()
    }
}
