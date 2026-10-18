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

/// Owns a router and a local TCP address to serve HTTP/1.1 there, while
/// answering each connection's one request through the router and closing every
/// connection it accepts.
///
/// Every connection carries one request and one response, then closes.
/// Concurrency model: reentrant. The server has no mutable state; each
/// ``start()`` call owns its own listener and connection tasks.
final class WebServer: Sendable {
    /// Routes that answer requests.
    private let router: Router
    /// Local address the listener binds.
    private let host: NWEndpoint.Host
    /// Local TCP port the listener binds.
    private let port: NWEndpoint.Port

    /// Creates a server that is not listening yet.
    ///
    /// - Parameters:
    ///   - router: Routes that answer requests.
    ///   - host: Local address to bind. Defaults to the IPv4 loopback address,
    ///     so only this machine can connect.
    ///   - port: TCP port to bind. Defaults to 8080.
    init(router: Router, host: NWEndpoint.Host = "127.0.0.1", port: NWEndpoint.Port = 8080) {
        self.router = router
        self.host = host
        self.port = port
    }

    /// Starts listening and serves connections until the calling task is
    /// cancelled or the listener fails.
    ///
    /// Connections are served concurrently, one child task each. After
    /// cancellation the call cancels every open connection, waits for their
    /// tasks to end, and returns normally. It returns at once when the task is
    /// already cancelled.
    ///
    /// - Throws: The listener's `NWError` when it cannot be created or fails,
    ///   for example because the port is in use. Open connections are
    ///   cancelled and their tasks have ended before the error is thrown.
    func start() async throws {
        guard !Task.isCancelled else {
            return
        }
        let listener = try buildListener()
        let (events, continuation) = AsyncStream.makeStream(of: ListenerEvent.self)
        defer {
            listener.cancel()
            continuation.finish()
        }
        listener.stateUpdateHandler = { state in
            self.handleListenerStateUpdate(state, continuation: continuation)
        }
        listener.newConnectionHandler = { connection in
            handleListenerNewConnection(connection, continuation: continuation)
        }
        listener.start(queue: DispatchQueue(label: "WebServer.Listener"))
        try await withThrowingDiscardingTaskGroup { group in
            try await addConnectionTasks(from: events, to: &group)
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
    /// in a cancelled group that task cancels its connection at once.
    ///
    /// - Parameters:
    ///   - events: Listener events in the order they occurred.
    ///   - group: Group that owns the connection tasks.
    /// - Throws: The listener's `NWError` when it fails.
    private func addConnectionTasks(
        from events: AsyncStream<ListenerEvent>,
        to group: inout ThrowingDiscardingTaskGroup<any Error>
    ) async throws {
        for await event in events {
            switch event {
            case .connectionAccepted(let connection):
                group.addTask { await self.handleConnection(connection) }
            case .listenerFailed(let error):
                throw error
            }
        }
    }

    /// Serves one accepted connection from start to close.
    ///
    /// The connection is cancelled on every path. Task cancellation cancels it
    /// at once, which ends a pending read or send. Failures are logged here
    /// because no caller can act on them: the connection is already lost.
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
    ///
    /// - Parameter connection: Started connection whose request has not been
    ///   read.
    /// - Throws: The connection's `NWError` when receiving or sending fails.
    private func handleRequest(on connection: NWConnection) async throws {
        do {
            let head = try await connection.readRequestHead()
            let request = try HTTPRequest(parsingHead: head)
            let response = await router.handleRequest(request)
            try await connection.sendResponse(response)
        } catch let error as HTTPRequestError {
            try await connection.sendResponse(HTTPResponse(requestError: error))
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
