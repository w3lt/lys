import Foundation

/// Largest accepted request head, in bytes, excluding the empty line that ends
/// it.
///
/// A head of exactly this size is accepted. A longer head is answered with
/// `431 Request Header Fields Too Large`.
let maximumRequestHeadByteCount = 8_192

/// Bytes that end a request head: the line break after the last line and the
/// empty line.
private let requestHeadTerminator = Data("\r\n\r\n".utf8)

/// Most bytes a connection reads while looking for its request head: an
/// accepted head plus the bytes that end it.
let maximumReceivedRequestHeadByteCount = maximumRequestHeadByteCount + requestHeadTerminator.count

/// Characters allowed in an RFC 9110 token (`tchar`): ASCII letters, digits,
/// and ``!#$%&'*+-.^_`|~``.
private let tokenCharacters = Set(
    "!#$%&'*+-.^_`|~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
)

/// Request-line facts that routing needs from one HTTP/1.x request.
///
/// Header fields and any body are not interpreted. Each connection carries one
/// request and then closes, so unread body bytes never reach another request.
struct HTTPRequest: Equatable, Sendable {
    /// Method token from the request line.
    let method: HTTPMethod
    /// Path of the origin-form request target, without its query. It is kept
    /// exactly as received: not percent-decoded and not normalized.
    let path: String
}

/// Reasons a received request cannot reach a route.
enum HTTPRequestError: Error, Equatable {
    /// The bytes are not an HTTP/1.x request head with an origin-form target,
    /// or the peer ended its stream before the head was complete.
    case malformedRequest
    /// The request head is longer than ``maximumRequestHeadByteCount`` bytes.
    case requestHeadTooLarge
    /// The request line names an HTTP major version other than 1.
    case unsupportedVersion
}

extension HTTPRequest {
    /// Parses the request line of one request head.
    ///
    /// The line must be `method SP request-target SP HTTP-version`, where the
    /// method is an RFC 9110 token, the target starts with `/`, and the version
    /// is `HTTP/1.x`. Header lines after it are not read.
    ///
    /// - Parameter head: Request head without the empty line that ends it, as
    ///   returned by ``findRequestHead(in:)``.
    /// - Throws: ``HTTPRequestError/unsupportedVersion`` for a well-formed
    ///   version other than `HTTP/1.x`, and
    ///   ``HTTPRequestError/malformedRequest`` for any other invalid line.
    init(parsingHead head: Data) throws(HTTPRequestError) {
        let requestLine = try parseRequestLine(head)
        let parts = requestLine.split(separator: " ", omittingEmptySubsequences: false)
        guard parts.count == 3 else {
            throw .malformedRequest
        }
        guard let version = parts[2].wholeMatch(of: /HTTP\/([0-9])\.[0-9]/) else {
            throw .malformedRequest
        }
        guard version.1 == "1" else {
            throw .unsupportedVersion
        }
        try self.init(method: parseMethod(parts[0]), path: parsePath(parts[1]))
    }
}

/// Finds the request head at the start of the bytes received so far.
///
/// - Parameter receivedBytes: Every byte received on the connection so far, in
///   arrival order.
/// - Returns: The head without the empty line that ends it, or `nil` while that
///   empty line has not arrived. Bytes after the empty line are ignored.
/// - Throws: ``HTTPRequestError/requestHeadTooLarge`` as soon as the head
///   cannot end within ``maximumRequestHeadByteCount`` bytes.
func findRequestHead(in receivedBytes: Data) throws(HTTPRequestError) -> Data? {
    if let terminatorRange = receivedBytes.range(of: requestHeadTerminator) {
        let head = receivedBytes[receivedBytes.startIndex..<terminatorRange.lowerBound]
        guard head.count <= maximumRequestHeadByteCount else {
            throw .requestHeadTooLarge
        }
        return Data(head)
    }
    guard receivedBytes.count < maximumReceivedRequestHeadByteCount else {
        throw .requestHeadTooLarge
    }
    return nil
}

/// Parses the first line of a request head into text.
///
/// - Parameter head: Request head without the empty line that ends it.
/// - Returns: The request line, which holds only spaces and visible ASCII
///   characters.
/// - Throws: ``HTTPRequestError/malformedRequest`` when the line is empty or
///   holds any other byte.
private func parseRequestLine(_ head: Data) throws(HTTPRequestError) -> String {
    let lineEnd = head.range(of: Data("\r\n".utf8))?.lowerBound ?? head.endIndex
    let lineBytes = head[head.startIndex..<lineEnd]
    guard !lineBytes.isEmpty, lineBytes.allSatisfy(isRequestLineByte) else {
        throw .malformedRequest
    }
    return String(decoding: lineBytes, as: UTF8.self)
}

/// Whether a byte may appear on a request line: a space or a visible ASCII
/// character.
///
/// - Parameter byte: One byte of the request line.
/// - Returns: `true` for bytes `0x20` through `0x7E`.
private func isRequestLineByte(_ byte: UInt8) -> Bool {
    (0x20...0x7E).contains(byte)
}

/// Parses the method token of a request line.
///
/// - Parameter token: First field of the request line.
/// - Returns: The method, compared case-sensitively.
/// - Throws: ``HTTPRequestError/malformedRequest`` when the token is empty or
///   holds a character that is not an RFC 9110 `tchar`.
private func parseMethod(_ token: Substring) throws(HTTPRequestError) -> HTTPMethod {
    guard !token.isEmpty, token.allSatisfy(tokenCharacters.contains) else {
        throw .malformedRequest
    }
    return HTTPMethod(token: String(token))
}

/// Parses the path of an origin-form request target such as
/// `/dummy-json?pretty=1`.
///
/// - Parameter target: Second field of the request line.
/// - Returns: The target up to, not including, its first `?`.
/// - Throws: ``HTTPRequestError/malformedRequest`` when the target does not
///   start with `/`.
private func parsePath(_ target: Substring) throws(HTTPRequestError) -> String {
    guard target.hasPrefix("/") else {
        throw .malformedRequest
    }
    return String(target.prefix { $0 != "?" })
}
