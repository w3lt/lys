import Foundation
import Network
import Testing
@testable import voice

/// Starts a socket server for one dictation test on a port the system picks.
///
/// - Parameter engine: Engine the server dictates with.
/// - Returns: The running server; the test stops it.
/// - Throws: The listener's error when it fails before becoming ready.
private func startDictationServer(engine: DictationEngine) async throws -> LoopbackServer {
    let server = SpeechSocketServer(engine: SilentSpeechEngine(), port: .any, dictationEngine: engine)
    let loopback = LoopbackServer()
    try await loopback.start { onReady in try await server.start(onReady: onReady) }
    return loopback
}

/// Starts a socket server whose dictation engine is ready.
///
/// - Parameter recognizer: The fake model the server dictates with.
/// - Returns: The running server; the test stops it.
/// - Throws: The listener's error when it fails before becoming ready.
private func startDictationServer(recognizer: FakeRecognizer = FakeRecognizer()) async throws -> LoopbackServer {
    try await startDictationServer(engine: try await startDictationEngine(recognizer: recognizer))
}

/// Opens a socket and starts a dictation on it.
///
/// - Parameter port: Port the server bound.
/// - Returns: The client, whose `transcribe` message was sent.
/// - Throws: ``TimedOutError`` when the handshake was not accepted in time.
private func startDictation(port: UInt16) async throws -> TestSocketClient {
    let client = TestSocketClient(port: port)
    try await waitUntil { client.isOpen }
    client.sendText(#"{"type":"transcribe"}"#)
    return client
}

/// Reads the next message as a dictation update.
///
/// - Parameter client: The client to read from.
/// - Returns: The update, or `nil` when the message is not one.
/// - Throws: The client's error when no message arrived.
private func readUpdate(from client: TestSocketClient) async throws -> DictationUpdate? {
    guard case .text(let body) = try await client.readMessage(),
          let object = try JSONSerialization.jsonObject(with: Data(body.utf8)) as? [String: String],
          let text = object["text"]
    else { return nil }
    switch object["type"] {
    case "partial": return .partial(text)
    case "final": return .final(text)
    default: return nil
    }
}

/// Checks the dictation protocol over the loopback socket, with the
/// recognizer faked.
@Suite("Dictation socket", .timeLimit(.minutes(1)))
struct DictationSocketTests {
    /// Verifies a dictation answers audio with the text so far, in order,
    /// and `stop` with the final text and a normal close.
    @Test func sendsPartialsThenTheFinalTextAndClosesNormally() async throws {
        let server = try await startDictationServer()
        defer { server.stop() }
        let client = try await startDictation(port: server.port)
        defer { client.cancel() }

        client.sendBinary(audibleAudio)
        #expect(try await readUpdate(from: client) == .partial("heard 1"))
        client.sendBinary(audibleAudio)
        #expect(try await readUpdate(from: client) == .partial("heard 2"))
        client.sendText(#"{"type":"stop"}"#)

        #expect(try await readUpdate(from: client) == .final("Heard 2."))
        #expect(try await client.readMessage() == .close(1000))
    }

    /// Verifies audio that changes nothing sends no update: the first
    /// message after silence and `stop` is the final text.
    @Test func sendsNoPartialWhileTheTextIsUnchanged() async throws {
        let server = try await startDictationServer()
        defer { server.stop() }
        let client = try await startDictation(port: server.port)
        defer { client.cancel() }

        client.sendBinary(silentAudio)
        client.sendText(#"{"type":"stop"}"#)

        #expect(try await readUpdate(from: client) == .final("Heard 0."))
    }

    /// Verifies audio and a `stop` sent after the first `stop` are dropped:
    /// the dictation still ends with its one final text and a normal close.
    @Test func dropsWhatFollowsStop() async throws {
        let server = try await startDictationServer()
        defer { server.stop() }
        let client = try await startDictation(port: server.port)
        defer { client.cancel() }

        client.sendText(#"{"type":"stop"}"#)
        client.sendBinary(audibleAudio)
        client.sendText(#"{"type":"stop"}"#)

        #expect(try await readUpdate(from: client) == .final("Heard 0."))
        #expect(try await client.readMessage() == .close(1000))
    }

    /// Verifies a newer dictation closes the older one with going-away and
    /// then hears from a cleared stream.
    @Test func aNewerDictationSupersedesTheOlderOne() async throws {
        let recognizer = FakeRecognizer()
        let server = try await startDictationServer(recognizer: recognizer)
        defer { server.stop() }
        let older = try await startDictation(port: server.port)
        defer { older.cancel() }
        older.sendBinary(audibleAudio)
        #expect(try await readUpdate(from: older) == .partial("heard 1"))

        let newer = try await startDictation(port: server.port)
        defer { newer.cancel() }

        #expect(try await older.readMessage() == .close(1001))
        newer.sendBinary(audibleAudio)
        #expect(try await readUpdate(from: newer) == .partial("heard 1"))
    }

    /// Verifies a client that goes away cancels its dictation, so the next
    /// one is heard from a cleared stream.
    @Test func aClosedSocketCancelsItsDictation() async throws {
        let recognizer = FakeRecognizer()
        let server = try await startDictationServer(recognizer: recognizer)
        defer { server.stop() }
        let gone = try await startDictation(port: server.port)
        gone.sendBinary(audibleAudio)
        #expect(try await readUpdate(from: gone) == .partial("heard 1"))

        gone.cancel()
        let next = try await startDictation(port: server.port)
        defer { next.cancel() }
        next.sendBinary(audibleAudio)

        #expect(try await readUpdate(from: next) == .partial("heard 1"))
        #expect(recognizer.resetCount == 2)
    }
}

/// Checks how the dictation socket refuses and fails.
@Suite("Dictation socket failures", .timeLimit(.minutes(1)))
struct DictationSocketFailureTests {
    /// Verifies a text message that is not `stop`, a second `transcribe`
    /// among them, is a protocol-error close.
    @Test(arguments: [#"{"type":"transcribe"}"#, #"{"type":"speak"}"#, "stop"])
    func aTextMessageThatIsNotStopIsAProtocolError(message: String) async throws {
        let server = try await startDictationServer()
        defer { server.stop() }
        let client = try await startDictation(port: server.port)
        defer { client.cancel() }

        client.sendText(message)

        #expect(try await client.readMessage() == .close(1002))
    }

    /// Verifies audio that ends in half a sample is a protocol-error close.
    @Test func audioThatIsNotWholeSamplesIsAProtocolError() async throws {
        let server = try await startDictationServer()
        defer { server.stop() }
        let client = try await startDictation(port: server.port)
        defer { client.cancel() }

        client.sendBinary(Data([0x00, 0x40, 0x01]))

        #expect(try await client.readMessage() == .close(1002))
    }

    /// Verifies a recognizer failure closes the socket with the
    /// internal-error code.
    @Test func recognitionFailureClosesWithInternalError() async throws {
        let recognizer = FakeRecognizer(FakeRecognizerBehavior(failsRecognition: true))
        let server = try await startDictationServer(recognizer: recognizer)
        defer { server.stop() }
        let client = try await startDictation(port: server.port)
        defer { client.cancel() }

        client.sendBinary(audibleAudio)

        #expect(try await client.readMessage() == .close(1011))
    }

    /// Verifies audio the recognizer falls too far behind closes the socket
    /// with the internal-error code.
    @Test func audioBeyondTheBacklogBoundClosesWithInternalError() async throws {
        let recognizer = FakeRecognizer(FakeRecognizerBehavior(holdsFirstAudio: true))
        let server = try await startDictationServer(recognizer: recognizer)
        defer {
            recognizer.releaseFirstAudio()
            server.stop()
        }
        let client = try await startDictation(port: server.port)
        defer { client.cancel() }
        client.sendBinary(audibleAudio)
        try await waitUntil { recognizer.startedAudioCount == 1 }

        for _ in 0 ... DictationEngine.maximumQueuedMessageCount {
            client.sendBinary(audibleAudio)
        }

        #expect(try await client.readMessage() == .close(1011))
    }

    /// Verifies every handshake is refused while the dictation model loads,
    /// so voice reports ready only when it can both speak and listen.
    @Test func refusesAHandshakeWhileTheDictationModelLoads() async throws {
        let server = try await startDictationServer(engine: DictationEngine(recognizer: FakeRecognizer()))
        defer { server.stop() }

        let client = TestSocketClient(port: server.port)
        defer { client.cancel() }

        try await waitUntil { client.isRefused }
        #expect(client.answeredStatus == 400)
    }
}
