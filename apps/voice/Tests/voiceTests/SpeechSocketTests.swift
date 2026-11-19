import Foundation
import Network
import Testing
@testable import voice

/// Speech frames the fake sessions synthesize: two frames per enqueued
/// sentence, each 80 ms of 24 kHz mono audio.
private let framesPerSentence = 2
private let samplesPerFrame = 1_920

/// Thrown when a synthesis fails inside the fake engine.
private struct FakeSynthesisError: Error {}

/// Thrown when the fake engine fails to start a session.
private struct FakeSessionStartError: Error {}

/// How a fake engine and its sessions behave; the default is a ready engine
/// whose sessions speak and end normally.
private struct FakeEngineBehavior {
    /// Whether the models count as loaded from the start.
    var isReady = true
    /// Whether every session fails synthesis once its text closes.
    var failsSynthesis = false
    /// Whether every session start fails.
    var failsSessionStart = false
    /// Whether the first session start waits until the test releases it.
    var holdsFirstSessionStart = false
    /// Whether a session's frames end when its text closes; when not, they
    /// end only when the session is cancelled.
    var endsFramesOnFinish = true
}

/// Fake speech session: emits a fixed number of frames as soon as a
/// sentence is added, and ends its frames on `closeText()`, or fails synthesis
/// then, or keeps them open, when configured to.
///
/// Concurrency model: serialized. The cancelled flag is read and written
/// under ``lock``; the frame continuation is safe to use from any thread.
private final class FakeSpeechSession: SpeechSession, @unchecked Sendable {
    /// Producer side of ``frames``.
    private let continuation: AsyncThrowingStream<[Float], any Error>.Continuation
    /// The stream of synthesized frames.
    let frames: AsyncThrowingStream<[Float], any Error>
    /// Whether every sentence fails to synthesize.
    private let failSynthesis: Bool
    /// Whether the frames end when the text closes.
    private let endsFramesOnFinish: Bool
    /// Guards ``cancelled``.
    private let lock = NSLock()
    /// Whether ``cancel()`` ran.
    private var cancelled = false

    /// Creates a session that has produced no frames.
    ///
    /// - Parameter behavior: The engine's behavior; its synthesis failure
    ///   makes `closeText()` fail the frame stream, with no frame produced
    ///   before.
    init(behavior: FakeEngineBehavior) {
        self.failSynthesis = behavior.failsSynthesis
        self.endsFramesOnFinish = behavior.endsFramesOnFinish
        (frames, continuation) = AsyncThrowingStream.makeStream(of: [Float].self)
    }

    /// Whether the connection cancelled the session.
    var isCancelled: Bool {
        lock.withLock { cancelled }
    }

    /// Emits the sentence's frames at once, unless synthesis fails.
    ///
    /// The sentence itself is not read: every sentence yields the same frames.
    func addText(_: String) {
        guard !failSynthesis else { return }
        for _ in 0 ..< framesPerSentence {
            continuation.yield([Float](repeating: 0.5, count: samplesPerFrame))
        }
    }

    /// Ends the frame stream, fails it when synthesis fails, or keeps it open
    /// when the frames do not end on finish.
    func closeText() {
        if failSynthesis {
            continuation.finish(throwing: FakeSynthesisError())
        } else if endsFramesOnFinish {
            continuation.finish()
        }
    }

    /// Records the cancellation and ends the frame stream.
    func cancel() async {
        lock.withLock { cancelled = true }
        continuation.finish()
    }
}

/// Fake engine the socket server under test talks to; it keeps every
/// session it made.
///
/// Concurrency model: serialized. Readiness, the session starts, and the
/// made sessions are read and written under ``lock``.
private final class FakeSpeechEngine: SpeechEngine, @unchecked Sendable {
    /// Guards every property below ``behavior``.
    private let lock = NSLock()
    /// How the engine and its sessions behave.
    private let behavior: FakeEngineBehavior
    /// Whether the models count as loaded.
    private var ready: Bool
    /// Every session made, in order.
    private var sessions: [FakeSpeechSession] = []
    /// How many session starts began.
    private var startCount = 0
    /// Whether the test released the held first start.
    private var isFirstStartReleased = false
    /// The held first start, while it waits.
    private var heldStart: CheckedContinuation<Void, Never>?

    /// Creates an engine.
    ///
    /// - Parameter behavior: How the engine and its sessions behave.
    init(_ behavior: FakeEngineBehavior = FakeEngineBehavior()) {
        self.behavior = behavior
        self.ready = behavior.isReady
    }

    /// Whether the models count as loaded.
    var isReady: Bool {
        lock.withLock { ready }
    }

    /// Every session made, in order.
    var madeSessions: [FakeSpeechSession] {
        lock.withLock { sessions }
    }

    /// Marks the models as loaded.
    func loadModels() async throws {
        lock.withLock { ready = true }
    }

    /// How many session starts began, held ones included.
    var startedSessionCount: Int {
        lock.withLock { startCount }
    }

    /// Makes and keeps one fake session, after the test released it when
    /// it is the held first start.
    ///
    /// - Returns: The new session.
    /// - Throws: ``FakeSessionStartError`` when session starts fail.
    func startSession() async throws -> any SpeechSession {
        let isHeld = lock.withLock { () -> Bool in
            startCount += 1
            return behavior.holdsFirstSessionStart && startCount == 1 && !isFirstStartReleased
        }
        if isHeld {
            await withCheckedContinuation { continuation in
                let isReleased = lock.withLock { () -> Bool in
                    if isFirstStartReleased { return true }
                    heldStart = continuation
                    return false
                }
                if isReleased { continuation.resume() }
            }
        }
        guard !behavior.failsSessionStart else { throw FakeSessionStartError() }
        let session = FakeSpeechSession(behavior: behavior)
        lock.withLock { sessions.append(session) }
        return session
    }

    /// Lets the held first session start go on.
    func releaseFirstSessionStart() {
        let held = lock.withLock { () -> CheckedContinuation<Void, Never>? in
            isFirstStartReleased = true
            defer { heldStart = nil }
            return heldStart
        }
        held?.resume()
    }
}

/// Starts a speech socket server for one test on a port the system picks.
///
/// - Parameters:
///   - engine: Engine the server speaks with.
///   - maxConnections: The server's connection cap.
///   - handshakeTimeout: The server's longest wait for a handshake.
/// - Returns: The running server; the test stops it.
/// - Throws: The listener's error when it fails before becoming ready.
private func startSpeechServer(
    engine: FakeSpeechEngine,
    maxConnections: Int = SpeechSocketServer.defaultMaxConnections,
    handshakeTimeout: Duration = SpeechSocketServer.defaultHandshakeTimeout
) async throws -> LoopbackServer {
    let server = SpeechSocketServer(
        jobs: VoiceJobs(
            speechEngine: engine,
            dictationEngine: try await startDictationEngine(recognizer: FakeRecognizer())
        ),
        settings: SpeechSocketServer.ListenerSettings(
            host: "127.0.0.1",
            port: .any,
            maxConnections: maxConnections,
            handshakeTimeout: handshakeTimeout
        )
    )
    let loopback = LoopbackServer()
    try await loopback.start { onReady in try await server.start(onReady: onReady) }
    return loopback
}

/// Checks the WebSocket handshake rules of the speech socket.
@Suite("Speech handshake", .timeLimit(.minutes(1)))
struct SpeechHandshakeTests {
    /// Verifies a handshake is accepted only when the models are loaded and no
    /// Origin header is present.
    ///
    /// - Parameters:
    ///   - isReady: Whether the models are loaded.
    ///   - headers: The handshake's header fields.
    ///   - expected: Whether the handshake is accepted.
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
        #expect(SpeechSocketServer.canAcceptHandshake(headers: headers.map { (name: $0.0, value: $0.1) }, isReady: isReady) == expected)
    }

    /// Verifies the listener refuses a browser's handshake, which carries an
    /// Origin header, and accepts the backend's, which does not.
    @Test func refusesAHandshakeWithAnOrigin() async throws {
        let server = try await startSpeechServer(engine: FakeSpeechEngine())
        defer { server.stop() }

        let browser = TestSocketClient(port: server.port, origin: "http://example.com")
        let backend = TestSocketClient(port: server.port)
        defer {
            browser.cancel()
            backend.cancel()
        }

        try await waitUntil { browser.isRefused }
        #expect(browser.answeredStatus == 400)
        try await waitUntil { backend.isOpen }
    }

    /// Verifies the listener refuses every handshake while the models load.
    @Test func refusesAHandshakeWhileTheModelsLoad() async throws {
        let server = try await startSpeechServer(engine: FakeSpeechEngine(FakeEngineBehavior(isReady: false)))
        defer { server.stop() }

        let client = TestSocketClient(port: server.port)
        defer { client.cancel() }

        try await waitUntil { client.isRefused }
        #expect(client.answeredStatus == 400)
    }

    /// Verifies a connection beyond the cap is dropped while the open one is
    /// still served.
    @Test func dropsConnectionsBeyondTheCap() async throws {
        let server = try await startSpeechServer(engine: FakeSpeechEngine(), maxConnections: 1)
        defer { server.stop() }

        let first = TestSocketClient(port: server.port)
        defer { first.cancel() }
        try await waitUntil { first.isOpen }
        let second = TestSocketClient(port: server.port)
        defer { second.cancel() }
        try await waitUntil { second.isRefused }
        #expect(second.answeredStatus == nil)

        first.sendText(#"{"type":"speak"}"#)
        first.sendText(#"{"type":"text","text":"One."}"#)
        guard case .binary = try await first.readMessage() else {
            Issue.record("Expected the open connection to keep speaking")
            return
        }
    }
}

extension SpeechHandshakeTests {
    /// Verifies a connection that completes no handshake is cancelled at the
    /// deadline, which frees its place under the cap.
    @Test func dropsAConnectionThatCompletesNoHandshake() async throws {
        let server = try await startSpeechServer(
            engine: FakeSpeechEngine(),
            maxConnections: 1,
            handshakeTimeout: .milliseconds(200)
        )
        defer { server.stop() }

        let idle = TestTCPClient(port: server.port)
        defer { idle.cancel() }
        do {
            _ = try await idle.readToEnd(within: 2)
        } catch is TimedOutError {
            Issue.record("Expected the server to cancel the idle connection")
            return
        } catch {
            // A reset also shows the drop.
            #expect(error is NWError)
        }
        let client = TestSocketClient(port: server.port)
        defer { client.cancel() }
        try await waitUntil { client.isOpen }
    }

    /// Verifies the deadline covers the handshake only: an open socket that
    /// stays quiet past it still speaks.
    @Test func keepsAQuietOpenSocketPastTheHandshakeDeadline() async throws {
        let server = try await startSpeechServer(
            engine: FakeSpeechEngine(),
            handshakeTimeout: .milliseconds(200)
        )
        defer { server.stop() }

        let client = TestSocketClient(port: server.port)
        defer { client.cancel() }
        try await waitUntil { client.isOpen }
        try await Task.sleep(for: .milliseconds(500))
        client.sendText(#"{"type":"speak"}"#)
        client.sendText(#"{"type":"text","text":"One."}"#)
        guard case .binary = try await client.readMessage() else {
            Issue.record("Expected the quiet socket to keep speaking")
            return
        }
    }
}

/// Checks one speech flow end to end over loopback.
@Suite("Speech over loopback", .timeLimit(.minutes(1)))
struct SpeechSocketFlowTests {
    /// Verifies a full speech: audio frames arrive in order, then a 1000 close.
    @Test func fullSpeechFlow() async throws {
        let server = try await startSpeechServer(engine: FakeSpeechEngine())
        defer { server.stop() }

        let client = TestSocketClient(port: server.port)
        defer { client.cancel() }
        client.sendText(#"{"type":"speak"}"#)
        client.sendText(#"{"type":"text","text":"One."}"#)
        client.sendText(#"{"type":"text","text":"Two."}"#)
        client.sendText(#"{"type":"finish"}"#)

        for _ in 0 ..< (2 * framesPerSentence) {
            let message = try await client.readMessage()
            guard case .binary(let frame) = message else {
                Issue.record("Expected a binary frame, got \(message)")
                return
            }
            #expect(frame.count == samplesPerFrame * 2)
        }
        let close = try await client.readMessage()
        #expect(close == .close(1000))
    }

    /// Verifies a newer speech supersedes the older one with a 1001 close and
    /// cancels its session.
    @Test func newerSpeechSupersedesOlderOne() async throws {
        let engine = FakeSpeechEngine()
        let server = try await startSpeechServer(engine: engine)
        defer { server.stop() }

        let first = TestSocketClient(port: server.port)
        let second = TestSocketClient(port: server.port)
        defer {
            first.cancel()
            second.cancel()
        }
        first.sendText(#"{"type":"speak"}"#)
        first.sendText(#"{"type":"text","text":"Long one."}"#)
        // A first frame proves the older speech is the active one before the
        // newer one starts.
        guard case .binary = try await first.readMessage() else {
            Issue.record("Expected the older speech to start speaking")
            return
        }
        second.sendText(#"{"type":"speak"}"#)

        let superseded = try await first.readClose()
        #expect(superseded == .close(1001))
        try await waitUntil { engine.madeSessions.first?.isCancelled == true }
    }

    /// Verifies a client that goes away mid-speech cancels the speech.
    @Test func closingTheClientCancelsTheSpeech() async throws {
        let engine = FakeSpeechEngine()
        let server = try await startSpeechServer(engine: engine)
        defer { server.stop() }

        let client = TestSocketClient(port: server.port)
        client.sendText(#"{"type":"speak"}"#)
        client.sendText(#"{"type":"text","text":"One."}"#)
        guard case .binary = try await client.readMessage() else {
            Issue.record("Expected the speech to start speaking")
            return
        }
        client.cancel()

        try await waitUntil { engine.madeSessions.first?.isCancelled == true }
    }

    /// Verifies a close does not wait without bound for audio a peer stopped
    /// reading: past the bound, the connection and the speech are cancelled.
    @Test func closingTowardsAPeerThatStoppedReadingCancelsTheSpeech() async throws {
        let engine = FakeSpeechEngine()
        let server = try await startSpeechServer(engine: engine)
        defer { server.stop() }

        let client = TestSocketClient(port: server.port)
        defer { client.cancel() }
        try await waitUntil { client.isOpen }
        client.stopReading()
        client.sendText(#"{"type":"speak"}"#)
        for _ in 0..<200 {
            client.sendText(#"{"type":"text","text":"One."}"#)
        }
        try await waitUntil { engine.madeSessions.first != nil }
        // Gives the server time to fill the connection's buffers.
        try await Task.sleep(for: .milliseconds(300))
        client.sendBinary()

        try await waitUntil(within: 5) { engine.madeSessions.first?.isCancelled == true }
    }

    /// Verifies text before `speak` is answered with a protocol-error close.
    @Test func textBeforeSpeakIsAProtocolError() async throws {
        let server = try await startSpeechServer(engine: FakeSpeechEngine())
        defer { server.stop() }

        let client = TestSocketClient(port: server.port)
        defer { client.cancel() }
        client.sendText(#"{"type":"text","text":"One."}"#)

        let close = try await client.readMessage()
        #expect(close == .close(1002))
    }

    /// Verifies a binary message from the client is refused.
    @Test func binaryMessageIsRefused() async throws {
        let server = try await startSpeechServer(engine: FakeSpeechEngine())
        defer { server.stop() }

        let client = TestSocketClient(port: server.port)
        defer { client.cancel() }
        client.sendBinary()

        let close = try await client.readMessage()
        #expect(close == .close(1003))
    }

    /// Verifies a text message that is not UTF-8 ends the connection with a
    /// protocol-error close, which Network.framework sends itself.
    @Test func textThatIsNotUTF8IsAProtocolError() async throws {
        let server = try await startSpeechServer(engine: FakeSpeechEngine())
        defer { server.stop() }

        let client = TestSocketClient(port: server.port)
        defer { client.cancel() }
        client.sendInvalidText()

        let close = try await client.readMessage()
        #expect(close == .close(1002))
    }

    /// Verifies an unknown message type is a protocol-error close.
    @Test func unknownMessageTypeIsAProtocolError() async throws {
        let server = try await startSpeechServer(engine: FakeSpeechEngine())
        defer { server.stop() }

        let client = TestSocketClient(port: server.port)
        defer { client.cancel() }
        client.sendText(#"{"type":"mystery"}"#)

        let close = try await client.readMessage()
        #expect(close == .close(1002))
    }

    /// Verifies a synthesis failure ends the speech with the internal-error close.
    @Test func synthesisFailureClosesWithInternalError() async throws {
        let server = try await startSpeechServer(engine: FakeSpeechEngine(FakeEngineBehavior(failsSynthesis: true)))
        defer { server.stop() }

        let client = TestSocketClient(port: server.port)
        defer { client.cancel() }
        client.sendText(#"{"type":"speak"}"#)
        client.sendText(#"{"type":"text","text":"One."}"#)
        client.sendText(#"{"type":"finish"}"#)

        let close = try await client.readMessage()
        #expect(close == .close(1011))
    }
}

/// Checks the speech protocol's other paths over loopback.
@Suite("Speech protocol paths", .timeLimit(.minutes(1)))
struct SpeechProtocolPathTests {
    /// Verifies text after `finish` is answered with a protocol-error close,
    /// while the speech is still speaking.
    @Test func textAfterFinishIsAProtocolError() async throws {
        let server = try await startSpeechServer(engine: FakeSpeechEngine(FakeEngineBehavior(endsFramesOnFinish: false)))
        defer { server.stop() }

        let client = TestSocketClient(port: server.port)
        defer { client.cancel() }
        client.sendText(#"{"type":"speak"}"#)
        client.sendText(#"{"type":"finish"}"#)
        client.sendText(#"{"type":"text","text":"One."}"#)

        #expect(try await client.readClose() == .close(1002))
    }

    /// Verifies `finish` before `speak` is answered with a protocol-error
    /// close.
    @Test func finishBeforeSpeakIsAProtocolError() async throws {
        let server = try await startSpeechServer(engine: FakeSpeechEngine())
        defer { server.stop() }

        let client = TestSocketClient(port: server.port)
        defer { client.cancel() }
        client.sendText(#"{"type":"finish"}"#)

        #expect(try await client.readMessage() == .close(1002))
    }

    /// Verifies a second `speak` on one connection cancels the connection's
    /// own speech and speaks the new one to its end.
    @Test func aSecondSpeakReplacesTheConnectionsOwnSpeech() async throws {
        let engine = FakeSpeechEngine()
        let server = try await startSpeechServer(engine: engine)
        defer { server.stop() }

        let client = TestSocketClient(port: server.port)
        defer { client.cancel() }
        client.sendText(#"{"type":"speak"}"#)
        client.sendText(#"{"type":"text","text":"One."}"#)
        guard case .binary = try await client.readMessage() else {
            Issue.record("Expected the first speech to start speaking")
            return
        }
        client.sendText(#"{"type":"speak"}"#)
        client.sendText(#"{"type":"text","text":"Two."}"#)
        client.sendText(#"{"type":"finish"}"#)

        #expect(try await client.readClose() == .close(1000))
        #expect(engine.madeSessions.count == 2)
        #expect(engine.madeSessions.first?.isCancelled == true)
    }

    /// Verifies a session that cannot start ends the speech with the
    /// internal-error close.
    @Test func failedSessionStartClosesWithInternalError() async throws {
        let server = try await startSpeechServer(engine: FakeSpeechEngine(FakeEngineBehavior(failsSessionStart: true)))
        defer { server.stop() }

        let client = TestSocketClient(port: server.port)
        defer { client.cancel() }
        client.sendText(#"{"type":"speak"}"#)

        #expect(try await client.readClose() == .close(1011))
    }

    /// Verifies a message over the size limit closes the socket with `1009`,
    /// which Network.framework sends itself, and cancels the speech.
    @Test func messageOverTheLimitClosesWithMessageTooBig() async throws {
        let engine = FakeSpeechEngine()
        let server = try await startSpeechServer(engine: engine)
        defer { server.stop() }

        let client = TestSocketClient(port: server.port)
        defer { client.cancel() }
        client.sendText(#"{"type":"speak"}"#)
        try await waitUntil { engine.madeSessions.first != nil }
        let sentence = String(repeating: "a", count: SpeechConnection.maximumMessageSize)
        client.sendText(#"{"type":"text","text":"\#(sentence)"}"#)

        #expect(try await client.readMessage() == .close(1009))
        try await waitUntil { engine.madeSessions.first?.isCancelled == true }
    }

    /// Verifies the speech whose `speak` arrived last is the one that speaks,
    /// even when an older speech's session starts after it.
    @Test func aSessionThatStartsLateDoesNotSupersedeANewerSpeech() async throws {
        let engine = FakeSpeechEngine(FakeEngineBehavior(holdsFirstSessionStart: true))
        let server = try await startSpeechServer(engine: engine)
        defer {
            engine.releaseFirstSessionStart()
            server.stop()
        }

        let older = TestSocketClient(port: server.port)
        let newer = TestSocketClient(port: server.port)
        defer {
            older.cancel()
            newer.cancel()
        }
        older.sendText(#"{"type":"speak"}"#)
        try await waitUntil { engine.startedSessionCount == 1 }
        newer.sendText(#"{"type":"speak"}"#)
        newer.sendText(#"{"type":"text","text":"One."}"#)
        guard case .binary = try await newer.readMessage() else {
            Issue.record("Expected the newer speech to start speaking")
            return
        }
        #expect(try await older.readClose() == .close(1001))

        engine.releaseFirstSessionStart()
        try await waitUntil { engine.madeSessions.count == 2 }
        // Gives a late registration the time to supersede the newer speech.
        try await Task.sleep(for: .milliseconds(200))
        newer.sendText(#"{"type":"finish"}"#)

        #expect(try await newer.readClose() == .close(1000))
        try await waitUntil { engine.madeSessions.last?.isCancelled == true }
    }

    /// Verifies stopping the server ends an open speech: the server's start
    /// call returns, the connection ends, and the session is cancelled.
    @Test func stoppingTheServerEndsAnOpenSpeech() async throws {
        let engine = FakeSpeechEngine()
        let server = try await startSpeechServer(engine: engine)
        defer { server.stop() }

        let client = TestSocketClient(port: server.port)
        defer { client.cancel() }
        client.sendText(#"{"type":"speak"}"#)
        client.sendText(#"{"type":"text","text":"One."}"#)
        guard case .binary = try await client.readMessage() else {
            Issue.record("Expected the speech to start speaking")
            return
        }

        try await server.stopAndWait()
        do {
            _ = try await client.readClose()
        } catch is ConnectionEndedError {
            // A cancelled connection ends without a close frame.
        }
        #expect(engine.madeSessions.first?.isCancelled == true)
    }
}
