import Foundation
import Network
import Synchronization

/// Thrown when an operation under test exceeds its allotted time.
struct TimedOutError: Error {}

/// Thrown when a test server stopped before its listener became ready.
struct ServerEndedError: Error {}

/// Polls `condition` every 10 ms until it holds.
///
/// - Parameters:
///   - seconds: Longest wait.
///   - condition: State the test waits for.
/// - Throws: ``TimedOutError`` when `condition` still fails at the deadline.
func waitUntil(within seconds: Double = 2, _ condition: () -> Bool) async throws {
    let deadline = ContinuousClock.now + .seconds(seconds)
    while !condition() {
        guard ContinuousClock.now < deadline else { throw TimedOutError() }
        try await Task.sleep(for: .milliseconds(10))
    }
}

/// One-shot handoff of the port a test server bound, or of why it could not.
///
/// Concurrency model: serialized. The outcome and the waiting continuation
/// are read and written under ``lock``; only the first outcome counts.
final class PortSignal: @unchecked Sendable {
    /// Guards ``outcome`` and ``waiter``.
    private let lock = NSLock()
    /// The first outcome delivered, if any.
    private var outcome: Result<UInt16, any Error>?
    /// The task waiting for the outcome, if one is.
    private var waiter: CheckedContinuation<UInt16, any Error>?

    /// Delivers `outcome` to the waiter; later calls are ignored.
    ///
    /// - Parameter outcome: The bound port, or the error that stopped the
    ///   server.
    func resolve(_ outcome: Result<UInt16, any Error>) {
        let waiter = lock.withLock { () -> CheckedContinuation<UInt16, any Error>? in
            guard self.outcome == nil else { return nil }
            self.outcome = outcome
            let waiter = self.waiter
            self.waiter = nil
            return waiter
        }
        waiter?.resume(with: outcome)
    }

    /// Waits for the outcome.
    ///
    /// - Returns: The bound port.
    /// - Throws: The error that stopped the server.
    func wait() async throws -> UInt16 {
        try await withCheckedThrowingContinuation { continuation in
            let delivered = lock.withLock { () -> Result<UInt16, any Error>? in
                if let outcome { return outcome }
                waiter = continuation
                return nil
            }
            if let delivered {
                continuation.resume(with: delivered)
            }
        }
    }
}

/// Whether a test server's task has ended.
///
/// Concurrency model: serialized under its `Mutex`.
final class ServerEnd: Sendable {
    /// Whether the server's task ended.
    private let ended = Mutex(false)

    /// Records that the server's task ended.
    func markEnded() {
        ended.withLock { $0 = true }
    }

    /// Whether the server's task ended.
    var hasEnded: Bool {
        ended.withLock { $0 }
    }
}

/// Runs one loopback server on a port the system picks, for one test.
///
/// Concurrency model: confined to the test's task; the server runs in a
/// task this object owns and cancels.
final class LoopbackServer {
    /// The port the server bound; `0` until ``start(_:)`` returned.
    private(set) var port: UInt16 = 0
    /// The task serving connections.
    private var task: Task<Void, Never>?
    /// Whether the serving task ended.
    private let end = ServerEnd()

    /// Starts a server, returning once its listener is ready.
    ///
    /// - Parameter start: Runs the server until cancelled, calling its
    ///   argument with the bound port once the listener is ready.
    /// - Throws: The server's error, or ``ServerEndedError``, when it stops before
    ///   its listener is ready.
    func start(_ start: @escaping @Sendable (@escaping @Sendable (NWEndpoint.Port) -> Void) async throws -> Void) async throws {
        let ready = PortSignal()
        let end = self.end
        task = Task {
            do {
                try await start { ready.resolve(.success($0.rawValue)) }
                ready.resolve(.failure(ServerEndedError()))
            } catch {
                ready.resolve(.failure(error))
            }
            end.markEnded()
        }
        port = try await ready.wait()
    }

    /// Stops the server.
    func stop() {
        task?.cancel()
    }

    /// Stops the server and waits until its start call returned.
    ///
    /// - Parameter seconds: Longest wait for the server to end.
    /// - Throws: ``TimedOutError`` when the server is still running at the
    ///   deadline.
    func stopAndWait(within seconds: Double = 2) async throws {
        task?.cancel()
        try await waitUntil(within: seconds) { end.hasEnded }
    }
}

/// Records the latest state of a client connection, for tests to poll.
///
/// Concurrency model: serialized under ``lock``; the connection reports
/// states on its queue while the test reads them.
final class ConnectionStates: @unchecked Sendable {
    /// Guards ``latest``.
    private let lock = NSLock()
    /// The state the connection reported last.
    private var latest: NWConnection.State = .setup

    /// Records `state` as the latest one.
    ///
    /// - Parameter state: State the connection reported.
    func update(_ state: NWConnection.State) {
        lock.withLock { latest = state }
    }

    /// Whether the connection is established; for a WebSocket, whether the
    /// handshake was accepted.
    var isReady: Bool {
        lock.withLock {
            if case .ready = latest { true } else { false }
        }
    }

    /// Whether the connection failed or waits after a refusal, so it will
    /// never be ready on its own.
    var isRefused: Bool {
        lock.withLock {
            switch latest {
            case .failed, .waiting: true
            default: false
            }
        }
    }
}

/// TCP client used to drive the HTTP server in tests.
///
/// Concurrency model: reentrant. The connection serializes its own sends
/// and receives; the client holds no other mutable state.
final class TestTCPClient: @unchecked Sendable {
    /// The client's connection.
    private let connection: NWConnection
    /// States the connection went through.
    let states = ConnectionStates()

    /// Connects to `port` on the loopback address.
    ///
    /// - Parameter port: Port the server bound.
    init(port: UInt16) {
        connection = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!, using: .tcp)
        let states = self.states
        connection.stateUpdateHandler = { states.update($0) }
        connection.start(queue: DispatchQueue(label: "test.tcp"))
    }

    /// Sends `text` as UTF-8.
    ///
    /// - Parameter text: Bytes to send.
    /// - Throws: The connection's `NWError` when sending fails.
    func send(_ text: String) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            connection.send(content: Data(text.utf8), completion: .contentProcessed { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            })
        }
    }

    /// Reads until the server ends its stream.
    ///
    /// Task cancellation cannot end a pending receive, so at the deadline
    /// this cancels the connection, which ends it.
    ///
    /// - Parameter seconds: Longest wait for the end of the stream.
    /// - Returns: Every byte the server sent.
    /// - Throws: ``TimedOutError`` when the stream did not end in time; the
    ///   connection's `NWError` when receiving fails.
    func readToEnd(within seconds: Double = 2) async throws -> Data {
        try await withThrowingTaskGroup(of: Data?.self) { group in
            group.addTask { try await self.readAll() }
            group.addTask {
                try await Task.sleep(for: .seconds(seconds))
                return nil
            }
            defer { group.cancelAll() }
            guard let received = try await group.next() ?? nil else {
                connection.cancel()
                throw TimedOutError()
            }
            return received
        }
    }

    /// Cancels the connection.
    func cancel() {
        connection.cancel()
    }

    /// Reads chunks until the server ends its stream.
    ///
    /// - Returns: Every byte received.
    /// - Throws: The connection's `NWError` when receiving fails.
    private func readAll() async throws -> Data {
        var received = Data()
        while true {
            let (bytes, isComplete) = try await readChunk()
            received.append(bytes)
            if isComplete { return received }
        }
    }

    /// Reads the next bytes available.
    ///
    /// - Returns: The bytes, possibly none, and whether the stream ended.
    /// - Throws: The connection's `NWError` when receiving fails.
    private func readChunk() async throws -> (Data, Bool) {
        try await withCheckedThrowingContinuation { continuation in
            connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { content, _, isComplete, error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: (content ?? Data(), isComplete))
                }
            }
        }
    }
}
