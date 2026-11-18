import Foundation
import Network
import Testing
@testable import voice

/// Speech frames the fake sessions synthesize: two frames per enqueued
/// sentence, each 80 ms of 24 kHz mono audio.
private let framesPerSentence = 2
private let samplesPerFrame = 1_920

/// Thrown when a synthesis fails inside the fake engine.
private struct FakeSynthesisFailure: Error {}

/// Fake speech session: emits a fixed number of frames as soon as a
/// sentence is enqueued, and ends its frames on `finish`, or fails synthesis
/// then when configured to.
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
    /// Guards ``cancelled``.
    private let lock = NSLock()
    /// Whether ``cancel()`` ran.
    private var cancelled = false

    /// Creates a session that has produced no frames.
    ///
    /// - Parameter failSynthesis: Whether `finish` fails the frame stream
    ///   instead of ending it, with no frame produced before.
    init(failSynthesis: Bool) {
        self.failSynthesis = failSynthesis
        (frames, continuation) = AsyncThrowingStream.makeStream(of: [Float].self)
    }

    /// Whether the connection cancelled the session.
    var isCancelled: Bool {
        lock.withLock { cancelled }
    }

    /// Emits the sentence's frames at once, unless synthesis fails.
    ///
    /// - Parameter text: Sentence to speak.
    func enqueue(_ text: String) {
        guard !failSynthesis else { return }
        for _ in 0 ..< framesPerSentence {
            continuation.yield([Float](repeating: 0.5, count: samplesPerFrame))
        }
    }

    /// Ends the frame stream, or fails it when synthesis fails.
    func finish() {
        if failSynthesis {
            continuation.finish(throwing: FakeSynthesisFailure())
        } else {
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
/// Concurrency model: serialized. Readiness and the made sessions are read
/// and written under ``lock``.
private final class FakeSpeechEngine: SpeechEngine, @unchecked Sendable {
    /// Guards ``ready`` and ``sessions``.
    private let lock = NSLock()
    /// Whether the models count as loaded.
    private var ready: Bool
    /// Every session made, in order.
    private var sessions: [FakeSpeechSession] = []
    /// Whether the sessions fail synthesis.
    private let failSynthesis: Bool

    /// Creates an engine.
    ///
    /// - Parameters:
    ///   - ready: Whether the models count as loaded from the start.
    ///   - failSynthesis: Whether every session fails synthesis.
    init(ready: Bool = true, failSynthesis: Bool = false) {
        self.ready = ready
        self.failSynthesis = failSynthesis
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
    func warmUp() async throws {
        lock.withLock { ready = true }
    }

    /// Makes and keeps one fake session.
    ///
    /// - Returns: The new session.
    func makeSession() async throws -> any SpeechSession {
        let session = FakeSpeechSession(failSynthesis: failSynthesis)
        lock.withLock { sessions.append(session) }
        return session
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

/// Thrown when the server ended the connection before the message a test
/// waited for.
private struct ConnectionEnded: Error {}

/// One server frame parsed from the received bytes.
private struct ParsedFrame {
    /// The message, or `nil` for a control frame the tests ignore.
    let message: ReceivedMessage?
    /// Bytes the frame took, header included.
    let length: Int
}

/// Minimal WebSocket client over plain TCP, used to drive the server in
/// tests the way the backend's `ws` client does.
///
/// It sends the upgrade request itself, parses the server's frames as the
/// bytes arrive, and answers the server's close frame. It reads every frame
/// on its own, so a close the test has not asked for yet is never lost; it
/// handles unfragmented frames only, which is all voice sends.
///
/// Concurrency model: serialized. The received bytes, the parsed messages,
/// and the handshake status are read and written under ``lock``; the
/// connection serializes its own sends and receives.
private final class TestSpeechClient: @unchecked Sendable {
    /// Mask applied to every client frame, as RFC 6455 requires.
    private static let mask: [UInt8] = [0x12, 0x34, 0x56, 0x78]

    /// The client's TCP connection.
    private let connection: NWConnection
    /// Guards every property below.
    private let lock = NSLock()
    /// Received bytes not parsed yet.
    private var unparsed = Data()
    /// Status of the server's handshake answer, once it arrived.
    private var handshakeStatus: Int?
    /// Every message received, in order.
    private var inbox: [ReceivedMessage] = []
    /// How many messages ``receive(within:)`` returned.
    private var handedOut = 0
    /// Whether the server ended the connection or receiving failed.
    private var ended = false

    /// Connects to the speech server on `port` and sends the upgrade request.
    ///
    /// - Parameters:
    ///   - port: Port the server bound.
    ///   - origin: `Origin` header to send, as a browser does; `nil` sends
    ///     none, as the backend does.
    init(port: UInt16, origin: String? = nil) {
        connection = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!, using: .tcp)
        connection.start(queue: DispatchQueue(label: "test.client"))
        var head = "GET / HTTP/1.1\r\nHost: 127.0.0.1:\(port)\r\nUpgrade: websocket\r\n"
            + "Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
            + "Sec-WebSocket-Version: 13\r\n"
        if let origin {
            head += "Origin: \(origin)\r\n"
        }
        sendBytes(Data((head + "\r\n").utf8))
        receiveNext()
    }

    /// Whether the server accepted the handshake.
    var isOpen: Bool {
        lock.withLock { handshakeStatus == 101 }
    }

    /// The status the server answered the handshake with, once it did.
    var answeredStatus: Int? {
        lock.withLock { handshakeStatus }
    }

    /// Whether the handshake was refused, or the connection ended without
    /// an answer, as a dropped one does.
    var isRefused: Bool {
        lock.withLock {
            if let handshakeStatus { handshakeStatus != 101 } else { ended }
        }
    }

    /// Sends one text message.
    ///
    /// - Parameter text: The message.
    func sendText(_ text: String) {
        sendFrame(opcode: 0x1, payload: Data(text.utf8))
    }

    /// Sends one binary message; the server must refuse it.
    func sendBinary() {
        sendFrame(opcode: 0x2, payload: Data([0x00, 0x01]))
    }

    /// Returns the next message the server sent, waiting for it.
    ///
    /// - Parameter seconds: Longest wait for the message.
    /// - Returns: The message.
    /// - Throws: ``TimedOut`` when no message arrived in time;
    ///   ``ConnectionEnded`` when the connection ended before it.
    func receive(within seconds: Double = 2) async throws -> ReceivedMessage {
        try await waitUntil(within: seconds) { hasMessageOrEnded }
        return try lock.withLock { () throws -> ReceivedMessage in
            guard handedOut < inbox.count else { throw ConnectionEnded() }
            handedOut += 1
            return inbox[handedOut - 1]
        }
    }

    /// Receives messages until the close frame, skipping audio before it.
    ///
    /// - Parameter seconds: Longest wait for each message.
    /// - Returns: The close message.
    /// - Throws: ``TimedOut`` when a message did not arrive in time;
    ///   ``ConnectionEnded`` when the connection ended before the close.
    func receiveClose(within seconds: Double = 2) async throws -> ReceivedMessage {
        while true {
            let message = try await receive(within: seconds)
            if case .close = message { return message }
        }
    }

    /// Ends the TCP connection without a close frame.
    func cancel() {
        connection.cancel()
    }

    /// Whether a message is waiting or the connection ended.
    private var hasMessageOrEnded: Bool {
        lock.withLock { handedOut < inbox.count || ended }
    }

    /// Receives the next bytes and parses them, until the connection ends.
    private func receiveNext() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] content, _, isComplete, error in
            guard let self else { return }
            let isEnd = isComplete || error != nil
            let replies = self.lock.withLock { () -> [Data] in
                if let content { unparsed.append(content) }
                let replies = parseReceivedBytes()
                if isEnd { ended = true }
                return replies
            }
            replies.forEach(sendBytes)
            if !isEnd { self.receiveNext() }
        }
    }

    /// Parses the handshake answer, then every complete frame received.
    ///
    /// Runs under ``lock``.
    ///
    /// - Returns: Frames to send in answer: a close frame echoing the
    ///   server's close code.
    private func parseReceivedBytes() -> [Data] {
        if handshakeStatus == nil {
            guard let headEnd = unparsed.firstRange(of: Data("\r\n\r\n".utf8)) else { return [] }
            let statusLine = String(decoding: unparsed[..<headEnd.lowerBound], as: UTF8.self)
            handshakeStatus = statusLine.split(separator: " ").dropFirst().first.flatMap { Int($0) } ?? 0
            unparsed = Data(unparsed[headEnd.upperBound...])
        }
        var replies: [Data] = []
        while let frame = Self.parseFrame(unparsed) {
            unparsed = Data(unparsed.dropFirst(frame.length))
            guard let message = frame.message else { continue }
            inbox.append(message)
            if case .close(let code) = message {
                let payload = code.map { Data([UInt8($0 >> 8), UInt8($0 & 0xFF)]) } ?? Data()
                replies.append(Self.buildFrame(opcode: 0x8, payload: payload))
            }
        }
        return replies
    }

    /// Parses one unmasked server frame at the start of `bytes`.
    ///
    /// - Parameter bytes: Received bytes, starting at a frame header.
    /// - Returns: The frame, or `nil` while it is incomplete.
    private static func parseFrame(_ bytes: Data) -> ParsedFrame? {
        let header = [UInt8](bytes.prefix(10))
        guard header.count >= 2 else { return nil }
        var payloadLength = Int(header[1] & 0x7F)
        var headerLength = 2
        if payloadLength == 126 {
            guard header.count >= 4 else { return nil }
            payloadLength = Int(header[2]) << 8 | Int(header[3])
            headerLength = 4
        } else if payloadLength == 127 {
            guard header.count >= 10 else { return nil }
            payloadLength = header[2 ..< 10].reduce(0) { $0 << 8 | Int($1) }
            headerLength = 10
        }
        guard bytes.count >= headerLength + payloadLength else { return nil }
        let payload = Data(bytes.dropFirst(headerLength).prefix(payloadLength))
        let length = headerLength + payloadLength
        switch header[0] & 0x0F {
        case 0x1:
            return ParsedFrame(message: .text(String(decoding: payload, as: UTF8.self)), length: length)
        case 0x2:
            return ParsedFrame(message: .binary(payload), length: length)
        case 0x8:
            let code = payload.count >= 2 ? UInt16(payload[payload.startIndex]) << 8 | UInt16(payload[payload.startIndex + 1]) : nil
            return ParsedFrame(message: .close(code), length: length)
        default:
            return ParsedFrame(message: nil, length: length)
        }
    }

    /// Builds one masked, unfragmented client frame.
    ///
    /// - Parameters:
    ///   - opcode: The frame's opcode.
    ///   - payload: The frame's payload.
    /// - Returns: The frame's bytes.
    private static func buildFrame(opcode: UInt8, payload: Data) -> Data {
        var frame = Data([0x80 | opcode])
        if payload.count < 126 {
            frame.append(0x80 | UInt8(payload.count))
        } else {
            frame.append(0x80 | 126)
            frame.append(UInt8(payload.count >> 8))
            frame.append(UInt8(payload.count & 0xFF))
        }
        frame.append(contentsOf: mask)
        frame.append(contentsOf: payload.enumerated().map { $0.element ^ mask[$0.offset % 4] })
        return frame
    }

    /// Sends one client frame.
    ///
    /// - Parameters:
    ///   - opcode: The frame's opcode.
    ///   - payload: The frame's payload, under 64 KiB.
    private func sendFrame(opcode: UInt8, payload: Data) {
        sendBytes(Self.buildFrame(opcode: opcode, payload: payload))
    }

    /// Sends raw bytes without waiting for them to be processed.
    ///
    /// - Parameter bytes: Bytes to send.
    private func sendBytes(_ bytes: Data) {
        connection.send(content: bytes, completion: .contentProcessed { _ in
            // The test asserts on what the server does next; the send
            // completion itself carries no information worth reacting to.
        })
    }
}

/// Starts a speech socket server for one test on a port the system picks.
///
/// - Parameters:
///   - engine: Engine the server speaks with.
///   - maxConnections: The server's connection cap.
/// - Returns: The running server; the test stops it.
/// - Throws: The listener's error when it fails before becoming ready.
private func startSpeechServer(
    engine: FakeSpeechEngine,
    maxConnections: Int = SpeechSocketServer.defaultMaxConnections
) async throws -> LoopbackServer {
    let server = SpeechSocketServer(engine: engine, port: .any, maxConnections: maxConnections)
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
        #expect(SpeechSocketServer.acceptsHandshake(headers: headers.map { (name: $0.0, value: $0.1) }, isReady: isReady) == expected)
    }

    /// Verifies the listener refuses a browser's handshake, which carries an
    /// Origin header, and accepts the backend's, which does not.
    @Test func refusesAHandshakeWithAnOrigin() async throws {
        let server = try await startSpeechServer(engine: FakeSpeechEngine())
        defer { server.stop() }

        let browser = TestSpeechClient(port: server.port, origin: "http://example.com")
        let backend = TestSpeechClient(port: server.port)
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
        let server = try await startSpeechServer(engine: FakeSpeechEngine(ready: false))
        defer { server.stop() }

        let client = TestSpeechClient(port: server.port)
        defer { client.cancel() }

        try await waitUntil { client.isRefused }
        #expect(client.answeredStatus == 400)
    }

    /// Verifies a connection beyond the cap is dropped while the open one is
    /// still served.
    @Test func dropsConnectionsBeyondTheCap() async throws {
        let server = try await startSpeechServer(engine: FakeSpeechEngine(), maxConnections: 1)
        defer { server.stop() }

        let first = TestSpeechClient(port: server.port)
        defer { first.cancel() }
        try await waitUntil { first.isOpen }
        let second = TestSpeechClient(port: server.port)
        defer { second.cancel() }
        try await waitUntil { second.isRefused }
        #expect(second.answeredStatus == nil)

        first.sendText(#"{"type":"speak"}"#)
        first.sendText(#"{"type":"text","text":"One."}"#)
        guard case .binary = try await first.receive() else {
            Issue.record("Expected the open connection to keep speaking")
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

        let client = TestSpeechClient(port: server.port)
        defer { client.cancel() }
        client.sendText(#"{"type":"speak"}"#)
        client.sendText(#"{"type":"text","text":"One."}"#)
        client.sendText(#"{"type":"text","text":"Two."}"#)
        client.sendText(#"{"type":"finish"}"#)

        for _ in 0 ..< (2 * framesPerSentence) {
            let message = try await client.receive()
            guard case .binary(let frame) = message else {
                Issue.record("Expected a binary frame, got \(message)")
                return
            }
            #expect(frame.count == samplesPerFrame * 2)
        }
        let close = try await client.receive()
        #expect(close == .close(1000))
    }

    /// Verifies a newer speech supersedes the older one with a 1001 close and
    /// cancels its session.
    @Test func newerSpeechSupersedesOlderOne() async throws {
        let engine = FakeSpeechEngine()
        let server = try await startSpeechServer(engine: engine)
        defer { server.stop() }

        let first = TestSpeechClient(port: server.port)
        let second = TestSpeechClient(port: server.port)
        defer {
            first.cancel()
            second.cancel()
        }
        first.sendText(#"{"type":"speak"}"#)
        first.sendText(#"{"type":"text","text":"Long one."}"#)
        // A first frame proves the older speech is the active one before the
        // newer one starts.
        guard case .binary = try await first.receive() else {
            Issue.record("Expected the older speech to start speaking")
            return
        }
        second.sendText(#"{"type":"speak"}"#)

        let superseded = try await first.receiveClose()
        #expect(superseded == .close(1001))
        try await waitUntil { engine.madeSessions.first?.isCancelled == true }
    }

    /// Verifies a client that goes away mid-speech cancels the speech.
    @Test func closingTheClientCancelsTheSpeech() async throws {
        let engine = FakeSpeechEngine()
        let server = try await startSpeechServer(engine: engine)
        defer { server.stop() }

        let client = TestSpeechClient(port: server.port)
        client.sendText(#"{"type":"speak"}"#)
        client.sendText(#"{"type":"text","text":"One."}"#)
        guard case .binary = try await client.receive() else {
            Issue.record("Expected the speech to start speaking")
            return
        }
        client.cancel()

        try await waitUntil { engine.madeSessions.first?.isCancelled == true }
    }

    /// Verifies text before `speak` is answered with a protocol-error close.
    @Test func textBeforeSpeakIsAProtocolError() async throws {
        let server = try await startSpeechServer(engine: FakeSpeechEngine())
        defer { server.stop() }

        let client = TestSpeechClient(port: server.port)
        defer { client.cancel() }
        client.sendText(#"{"type":"text","text":"One."}"#)

        let close = try await client.receive()
        #expect(close == .close(1002))
    }

    /// Verifies a binary message from the client is refused.
    @Test func binaryMessageIsRefused() async throws {
        let server = try await startSpeechServer(engine: FakeSpeechEngine())
        defer { server.stop() }

        let client = TestSpeechClient(port: server.port)
        defer { client.cancel() }
        client.sendBinary()

        let close = try await client.receive()
        #expect(close == .close(1003))
    }

    /// Verifies an unknown message type is a protocol-error close.
    @Test func unknownMessageTypeIsAProtocolError() async throws {
        let server = try await startSpeechServer(engine: FakeSpeechEngine())
        defer { server.stop() }

        let client = TestSpeechClient(port: server.port)
        defer { client.cancel() }
        client.sendText(#"{"type":"mystery"}"#)

        let close = try await client.receive()
        #expect(close == .close(1002))
    }

    /// Verifies a synthesis failure ends the speech with the internal-error close.
    @Test func synthesisFailureClosesWithInternalError() async throws {
        let server = try await startSpeechServer(engine: FakeSpeechEngine(failSynthesis: true))
        defer { server.stop() }

        let client = TestSpeechClient(port: server.port)
        defer { client.cancel() }
        client.sendText(#"{"type":"speak"}"#)
        client.sendText(#"{"type":"text","text":"One."}"#)
        client.sendText(#"{"type":"finish"}"#)

        let close = try await client.receive()
        #expect(close == .close(1011))
    }
}
