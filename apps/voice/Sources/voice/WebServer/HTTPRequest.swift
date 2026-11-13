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

/// Request-line facts that routing and routes need from one HTTP/1.x request.
///
/// Header fields and any body are not interpreted. Each connection carries one
/// request and then closes, so unread body bytes never reach another request.
struct HTTPRequest: Equatable, Sendable {
    /// Method token from the request line.
    let method: HTTPMethod
    /// Path of the origin-form request target, without its query. It is kept
    /// exactly as received: not percent-decoded and not normalized.
    let path: String
    /// Decoded parameters of the target's query, in the order received.
    ///
    /// A repeated name is kept once per occurrence; a route that needs one value
    /// for a name decides how to answer a repeat. Routing does not read it. It
    /// is empty when the target has no `?`, or nothing but `&` after it.
    let query: [HTTPQueryParameter]
}

/// One name and value from the query of a request target, decoded as a URL
/// form encodes them: `+` is a space and `%XX` is one UTF-8 byte.
struct HTTPQueryParameter: Equatable, Sendable {
    /// Decoded name. It is empty for a segment such as `=1`.
    let name: String
    /// Decoded value. It is empty both for `name=` and for a bare `name`
    /// without `=`.
    let value: String
}

/// Reasons a received request cannot reach a route.
enum HTTPRequestError: Error, Equatable {
    /// The bytes are not an HTTP/1.x request head with an origin-form target,
    /// the target's query cannot be decoded, or the peer ended its stream
    /// before the head was complete.
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
    /// method is an RFC 9110 token, the target starts with `/` and has a
    /// decodable query, and the version is `HTTP/1.x`. Header lines after it
    /// are not read.
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
        try self.init(method: parseMethod(parts[0]), path: parsePath(parts[1]), query: parseQuery(parts[1]))
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
/// `/read?url=https%3A%2F%2Fa.com`.
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

/// Parses the query of an origin-form request target such as
/// `/read?url=https%3A%2F%2Fa.com&x=1+2`.
///
/// The query is everything after the first `?`. It is split on `&`, and empty
/// segments are skipped, as a URL form parser does. Its size is bounded by
/// ``maximumRequestHeadByteCount``.
///
/// - Parameter target: Second field of the request line.
/// - Returns: The query's parameters in order, repeated names included.
/// - Throws: ``HTTPRequestError/malformedRequest`` when a name or value cannot
///   be decoded.
private func parseQuery(_ target: Substring) throws(HTTPRequestError) -> [HTTPQueryParameter] {
    guard let queryStart = target.firstIndex(of: "?") else {
        return []
    }
    return try target[target.index(after: queryStart)...]
        .split(separator: "&")
        .map(parseQueryParameter)
}

/// Parses one non-empty `&`-separated segment of a query.
///
/// The name ends at the first `=`, so later `=` characters belong to the
/// value. A segment without `=` is a name with an empty value.
///
/// - Parameter segment: Text of the query between `&` separators; never
///   empty.
/// - Returns: The decoded name and value.
/// - Throws: ``HTTPRequestError/malformedRequest`` when the name or value
///   cannot be decoded.
private func parseQueryParameter(_ segment: Substring) throws(HTTPRequestError) -> HTTPQueryParameter {
    guard let separatorIndex = segment.firstIndex(of: "=") else {
        return try HTTPQueryParameter(name: parseQueryComponent(segment), value: "")
    }
    let name = try parseQueryComponent(segment[..<separatorIndex])
    let value = try parseQueryComponent(segment[segment.index(after: separatorIndex)...])
    return HTTPQueryParameter(name: name, value: value)
}

/// Parses one name or value of a query, decoded as a URL form encodes it.
///
/// Each `+` is a space, each `%` and the two hex digits after it are one byte,
/// and every other character is kept. The bytes are then read as UTF-8; a
/// leading byte order mark is kept as U+FEFF.
///
/// - Parameter component: Text before or after the first `=` of a query
///   segment.
/// - Returns: The decoded text.
/// - Throws: ``HTTPRequestError/malformedRequest`` when a `%` is not followed
///   by two hex digits or the decoded bytes are not valid UTF-8.
private func parseQueryComponent(_ component: Substring) throws(HTTPRequestError) -> String {
    // Empty runs are kept, so the run before the first `%` always exists, and
    // every later run starts right after a `%`.
    let runs = component.replacing("+", with: " ").split(separator: "%", omittingEmptySubsequences: false)
    var decodedBytes = Array(runs[0].utf8)
    for escapedRun in runs.dropFirst() {
        try decodedBytes.append(parsePercentEscapedByte(escapedRun.prefix(2)))
        decodedBytes.append(contentsOf: escapedRun.dropFirst(2).utf8)
    }
    guard let decodedText = String(validating: decodedBytes, as: UTF8.self) else {
        throw .malformedRequest
    }
    return decodedText
}

/// Parses the hex digits after a `%` in a query into the byte they name.
///
/// - Parameter hexDigits: The characters that follow the `%`, at most two.
/// - Returns: The byte; upper- and lower-case digits are equal.
/// - Throws: ``HTTPRequestError/malformedRequest`` when fewer than two
///   characters follow the `%` or either one is not an ASCII hex digit.
private func parsePercentEscapedByte(_ hexDigits: Substring) throws(HTTPRequestError) -> UInt8 {
    let digitValues = hexDigits.compactMap(\.hexDigitValue)
    guard hexDigits.allSatisfy(\.isASCII), digitValues.count == 2 else {
        throw .malformedRequest
    }
    return UInt8(digitValues[0] * 16 + digitValues[1])
}
