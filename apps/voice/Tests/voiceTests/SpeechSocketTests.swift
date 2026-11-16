import Foundation
import Network
import Testing
@testable import voice

/// Speech frames the fake sessions synthesize: two frames per enqueued
/// sentence, each 80 ms of 24 kHz mono audio.
private let framesPerSentence = 2
private let samplesPerFrame = 1_920

/// Thrown when an operation under test exceeds its allotted time.
private struct TimedOut: Error {}

/// Thrown when a synthesis fails inside the fake engine.
private struct FakeSynthesisFailure: Error {}

/// Runs `operation`, failing with ``TimedOut`` when it does not finish soon.
private func withTimeout<T: Sendable>(_ seconds: Double, _ operation: @escaping @Sendable () async throws -> T) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask { try await operation() }
        group.addTask {
            try await Task.sleep(for: .seconds(seconds))
            throw TimedOut()
        }
        let result = try await group.next()
        group.cancelAll()
        guard let result else { throw TimedOut() }
        return result
    }
}

/// Fake speech session: emits a fixed number of frames per enqueued sentence
/// when it finishes, or fails synthesis when configured to.
private final class FakeSpeechSession: SpeechSession, @unchecked Sendable {
    private let continuation: AsyncThrowingStream<[Float], any Error>.Continuation
    /// The stream of synthesized frames.
    let frames: AsyncThrowingStream<[Float], any Error>
    private let lock = NSLock()
    private var enqueued: [String] = []
    private let failSynthesis: Bool

    init(failSynthesis: Bool) {
        self.failSynthesis = failSynthesis
        var continuation: AsyncThrowingStream<[Float], any Error>.Continuation!
        frames = AsyncThrowingStream { continuation = $0 }
        self.continuation = continuation
    }

    func enqueue(_ text: String) {
        lock.withLock { enqueued.append(text) }
    }

    func finish() {
        if failSynthesis {
            continuation.finish(throwing: FakeSynthesisFailure())
            return
        }
        let count = lock.withLock { enqueued.count }
        for _ in 0 ..< (count * framesPerSentence) {
            continuation.yield([Float](repeating: 0.5, count: samplesPerFrame))
        }
        continuation.finish()
    }

    func cancel() async {
        continuation.finish()
    }
}

/// Fake engine the socket server under test talks to.
private final class FakeSpeechEngine: SpeechEngine, @unchecked Sendable {
    private let lock = NSLock()
    private var ready = false
    private let failSynthesis: Bool

    init(ready: Bool = true, failSynthesis: Bool = false) {
        self.ready = ready
        self.failSynthesis = failSynthesis
    }

    var isReady: Bool {
        lock.withLock { ready }
    }

    func warmUp() async throws {
        lock.withLock { ready = true }
    }

    func makeSession() async throws -> any SpeechSession {
        FakeSpeechSession(failSynthesis: failSynthesis)
    }
}

/// One message received by the test client.
private enum ReceivedMessage: Equatable {
    /// A text message.
    case text(String)
    /// A binary message.
    case binary(Data)
    /// A close frame with its close code, if the peer sent one.
    case close(UInt16?)
}

/// WebSocket client used to drive the server in tests.
private final class TestSpeechClient: @unchecked Sendable {
    private let connection: NWConnection

    init(port: UInt16) {
        let options = NWProtocolWebSocket.Options()
        options.autoReplyPing = true
        let parameters = NWParameters.tcp
        parameters.defaultProtocolStack.applicationProtocols = [options]
        connection = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!, using: parameters)
        connection.start(queue: DispatchQueue(label: "test.client"))
    }

    /// Sends one text message.
    func sendText(_ text: String) {
        send(Data(text.utf8), opcode: .text)
    }

    /// Sends one binary message; the server must refuse it.
    func sendBinary() {
        send(Data([0x00, 0x01]), opcode: .binary)
    }

    /// Receives the next message the server sends.
    func receive() async throws -> ReceivedMessage {
        try await withCheckedThrowingContinuation { continuation in
            connection.receiveMessage { content, context, _, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata
                switch metadata?.opcode {
                case .close:
                    continuation.resume(returning: .close(Self.closeCodeValue(metadata?.closeCode)))
                case .binary:
                    continuation.resume(returning: .binary(content ?? Data()))
                case .text:
                    continuation.resume(returning: .text(String(data: content ?? Data(), encoding: .utf8) ?? ""))
                default:
                    continuation.resume(returning: .close(nil))
                }
            }
        }
    }

    /// Cancels the connection.
    func cancel() {
        connection.cancel()
    }

    private func send(_ data: Data, opcode: NWProtocolWebSocket.Opcode) {
        let metadata = NWProtocolWebSocket.Metadata(opcode: opcode)
        let context = NWConnection.ContentContext(identifier: "test", metadata: [metadata])
        connection.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed { _ in })
    }

    /// Maps a WebSocket close code onto its 16-bit code, if any.
    private static func closeCodeValue(_ code: NWProtocolWebSocket.CloseCode?) -> UInt16? {
        switch code {
        case .protocolCode(.normalClosure): 1000
        case .protocolCode(.goingAway): 1001
        case .protocolCode(.protocolError): 1002
        case .protocolCode(.unsupportedData): 1003
        case .protocolCode(.internalServerError): 1011
        case .applicationCode(let code), .privateCode(let code): code
        case .protocolCode, .none: nil
        }
    }
}

/// Runs the speech socket server on a random loopback port for one test.
private final class SpeechServerFixture {
    let engine: FakeSpeechEngine
    let port: UInt16
    private let server: SpeechSocketServer
    private var task: Task<Void, Never>?

    init(engine: FakeSpeechEngine) {
        self.engine = engine
        self.port = UInt16.random(in: 20000 ... 45000)
        self.server = SpeechSocketServer(engine: engine, port: NWEndpoint.Port(rawValue: port)!)
    }

    /// Starts the server, resolving once its listener is ready.
    ///
    /// - Throws: The listener's error when it fails before becoming ready.
    func start() async throws {
        let ready = ReadySignal()
        task = Task {
            do {
                try await server.start(onReady: { ready.signal(.success(())) })
            } catch {
                ready.signal(.failure(error))
            }
        }
        try await ready.wait()
    }

    /// Stops the server.
    func stop() {
        task?.cancel()
    }
}

/// One-shot signal used to wait for the server's listener, or to observe
/// its failure.
private final class ReadySignal: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Void, any Error>?
    private var outcome: Result<Void, any Error>?

    func signal(_ outcome: Result<Void, any Error>) {
        lock.lock()
        if let continuation {
            self.continuation = nil
            lock.unlock()
            continuation.resume(with: outcome)
            return
        }
        self.outcome = outcome
        lock.unlock()
    }

    func wait() async throws {
        let ready = lock.withLock { outcome }
        if let ready {
            return try ready.get()
        }
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            if let outcome {
                lock.unlock()
                continuation.resume(with: outcome)
                return
            }
            self.continuation = continuation
            lock.unlock()
        }
    }
}

/// Checks the WebSocket handshake rules of the speech socket.
@Suite("Speech handshake")
struct SpeechHandshakeTests {
    /// Verifies a handshake is accepted only when the models are loaded and no
    /// Origin header is present.
    @Test(
        "Accepts only ready peers without an Origin header",
        arguments: [
            (true, [("host", "127.0.0.1")], true),
            (true, [("Origin", "tauri://localhost")], false),
            (true, [("origin", "http://example.com")], false),
            (false, [], false),
            (false, [("Origin", "tauri://localhost")], false),
        ] as [(Bool, [(String, String)], Bool)]
    )
    func acceptsOnlyReadyPeersWithoutOrigin(isReady: Bool, headers: [(String, String)], expected: Bool) {
        #expect(SpeechSocketServer.acceptsHandshake(headers: headers.map { (name: $0.0, value: $0.1) }, isReady: isReady) == expected)
    }
}

/// Checks one speech flow end to end over loopback.
@Suite("Speech over loopback", .timeLimit(.minutes(1)))
struct SpeechSocketFlowTests {
    /// Verifies a full speech: audio frames arrive in order, then a 1000 close.
    @Test func fullSpeechFlow() async throws {
        let fixture = SpeechServerFixture(engine: FakeSpeechEngine())
        try await fixture.start()
        defer { fixture.stop() }

        let client = TestSpeechClient(port: fixture.port)
        defer { client.cancel() }
        client.sendText(#"{"type":"speak"}"#)
        client.sendText(#"{"type":"text","text":"One."}"#)
        client.sendText(#"{"type":"text","text":"Two."}"#)
        client.sendText(#"{"type":"finish"}"#)

        for _ in 0 ..< (2 * framesPerSentence) {
            let message = try await withTimeout(2) { try await client.receive() }
            guard case .binary(let frame) = message else {
                Issue.record("Expected a binary frame, got \(message)")
                return
            }
            #expect(frame.count == samplesPerFrame * 2)
        }
        let close = try await withTimeout(2) { try await client.receive() }
        #expect(close == .close(1000))
    }

    /// Verifies a newer speech supersedes the older one with a 1001 close.
    @Test func newerSpeechSupersedesOlderOne() async throws {
        let fixture = SpeechServerFixture(engine: FakeSpeechEngine())
        try await fixture.start()
        defer { fixture.stop() }

        let first = TestSpeechClient(port: fixture.port)
        let second = TestSpeechClient(port: fixture.port)
        defer {
            first.cancel()
            second.cancel()
        }
        first.sendText(#"{"type":"speak"}"#)
        first.sendText(#"{"type":"text","text":"Long one."}"#)
        second.sendText(#"{"type":"speak"}"#)

        let superseded = try await withTimeout(2) { try await first.receive() }
        #expect(superseded == .close(1001))
    }

    /// Verifies text before `speak` is answered with a protocol-error close.
    @Test func textBeforeSpeakIsAProtocolError() async throws {
        let fixture = SpeechServerFixture(engine: FakeSpeechEngine())
        try await fixture.start()
        defer { fixture.stop() }

        let client = TestSpeechClient(port: fixture.port)
        client.sendText(#"{"type":"text","text":"One."}"#)

        let close = try await withTimeout(2) { try await client.receive() }
        #expect(close == .close(1002))
    }

    /// Verifies a binary message from the client is refused.
    @Test func binaryMessageIsRefused() async throws {
        let fixture = SpeechServerFixture(engine: FakeSpeechEngine())
        try await fixture.start()
        defer { fixture.stop() }

        let client = TestSpeechClient(port: fixture.port)
        client.sendBinary()

        let close = try await withTimeout(2) { try await client.receive() }
        #expect(close == .close(1003))
    }

    /// Verifies an unknown message type is a protocol-error close.
    @Test func unknownMessageTypeIsAProtocolError() async throws {
        let fixture = SpeechServerFixture(engine: FakeSpeechEngine())
        try await fixture.start()
        defer { fixture.stop() }

        let client = TestSpeechClient(port: fixture.port)
        client.sendText(#"{"type":"mystery"}"#)

        let close = try await withTimeout(2) { try await client.receive() }
        #expect(close == .close(1002))
    }

    /// Verifies a synthesis failure ends the speech with the internal-error close.
    @Test func synthesisFailureClosesWithInternalError() async throws {
        let fixture = SpeechServerFixture(engine: FakeSpeechEngine(failSynthesis: true))
        try await fixture.start()
        defer { fixture.stop() }

        let client = TestSpeechClient(port: fixture.port)
        defer { client.cancel() }
        client.sendText(#"{"type":"speak"}"#)
        client.sendText(#"{"type":"text","text":"One."}"#)
        client.sendText(#"{"type":"finish"}"#)

        let close = try await withTimeout(2) { try await client.receive() }
        #expect(close == .close(1011))
    }
}
