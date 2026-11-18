import Foundation
import Network

/// One message received by the test client.
enum ReceivedMessage: Equatable {
    /// A text message.
    case text(String)
    /// A binary message.
    case binary(Data)
    /// A close frame with its close code, if the peer sent one.
    case close(UInt16?)
}

/// Thrown when the server ended the connection before the message a test
/// waited for.
struct ConnectionEndedError: Error {}

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
final class TestSocketClient: @unchecked Sendable {
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
    /// How many messages ``readMessage(within:)`` returned.
    private var handedOut = 0
    /// Whether the server ended the connection or receiving failed.
    private var ended = false
    /// Whether the test stopped reading, so the server's sends back up.
    private var isReadingPaused = false

    /// Connects to the socket server on `port` and sends the upgrade request.
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
        readNextBytes()
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

    /// Sends one binary message, which a speech must refuse and a dictation
    /// reads as audio.
    ///
    /// - Parameter payload: The message's bytes; one silent sample by
    ///   default.
    func sendBinary(_ payload: Data = Data([0x00, 0x00])) {
        sendFrame(opcode: 0x2, payload: payload)
    }

    /// Sends one text message whose payload is not UTF-8; the server must
    /// refuse it.
    func sendInvalidText() {
        sendFrame(opcode: 0x1, payload: Data([0xFF]))
    }

    /// Returns the next message the server sent, waiting for it.
    ///
    /// - Parameter seconds: Longest wait for the message.
    /// - Returns: The message.
    /// - Throws: ``TimedOutError`` when no message arrived in time;
    ///   ``ConnectionEndedError`` when the connection ended before it.
    func readMessage(within seconds: Double = 2) async throws -> ReceivedMessage {
        try await waitUntil(within: seconds) { hasMessageOrEnded }
        return try lock.withLock { () throws -> ReceivedMessage in
            guard handedOut < inbox.count else { throw ConnectionEndedError() }
            handedOut += 1
            return inbox[handedOut - 1]
        }
    }

    /// Receives messages until the close frame, skipping those before it.
    ///
    /// - Parameter seconds: Longest wait for each message.
    /// - Returns: The close message.
    /// - Throws: ``TimedOutError`` when a message did not arrive in time;
    ///   ``ConnectionEndedError`` when the connection ended before the close.
    func readClose(within seconds: Double = 2) async throws -> ReceivedMessage {
        while true {
            let message = try await readMessage(within: seconds)
            if case .close = message { return message }
        }
    }

    /// Stops reading once the receive already pending completes, so the
    /// server's sends back up as they do towards a peer that stopped reading.
    func stopReading() {
        lock.withLock { isReadingPaused = true }
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
    private func readNextBytes() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] content, _, isComplete, error in
            guard let self else { return }
            let isEnd = isComplete || error != nil
            let (replies, isPaused) = self.lock.withLock { () -> ([Data], Bool) in
                if let content { unparsed.append(content) }
                let replies = parseReceivedBytes()
                if isEnd { ended = true }
                return (replies, isReadingPaused)
            }
            replies.forEach(sendBytes)
            if !isEnd && !isPaused { self.readNextBytes() }
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
