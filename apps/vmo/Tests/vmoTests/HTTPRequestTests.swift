import Foundation
import Testing
@testable import vmo

/// Bytes that end a request head on the wire.
private let emptyLine = Data("\r\n\r\n".utf8)

/// Builds request-head bytes of an exact size: a request line and one header
/// field padded with `a`.
///
/// - Parameter byteCount: Size of the head in bytes; at least 27.
/// - Returns: A valid `GET /` head without the empty line that ends it.
private func buildHead(byteCount: Int) -> Data {
    let prefix = "GET / HTTP/1.1\r\nX-Padding: "
    let padding = String(repeating: "a", count: byteCount - prefix.utf8.count)
    return Data((prefix + padding).utf8)
}

/// Checks how a request head becomes an ``HTTPRequest`` and which heads are
/// refused.
@Suite("Parsing a request head")
struct HTTPRequestParsingTests {
    /// Verifies that only the request line decides the method and path; the
    /// header lines after it are not routed on.
    @Test("Reads the method and path from the request line and ignores header lines")
    func readsMethodAndPath() throws {
        let request = try HTTPRequest(parsingHead: Data("GET /web/read-page HTTP/1.1\r\nHost: localhost".utf8))

        #expect(request == HTTPRequest(method: .get, path: "/web/read-page", query: []))
    }

    /// Verifies that the query is split from the path, so `/read?…` still
    /// reaches `/read`, and that its names and values arrive decoded.
    @Test("Splits the query from the path and decodes its parameters")
    func splitsQueryFromPath() throws {
        let request = try HTTPRequest(parsingHead: Data("GET /read?url=https%3A%2F%2Fa.com&x=1+2 HTTP/1.1".utf8))

        #expect(request.path == "/read")
        #expect(request.query == [
            HTTPQueryParameter(name: "url", value: "https://a.com"),
            HTTPQueryParameter(name: "x", value: "1 2"),
        ])
    }

    /// Verifies how a query is split and decoded: empty segments are skipped,
    /// repeats are kept in order, only the first `=` separates, `+` is a space
    /// while `%2B` is a plus, hex digits of either case are UTF-8 bytes, a
    /// leading byte order mark is kept, and other characters stay as they are.
    ///
    /// - Parameters:
    ///   - target: Request target of a `GET` request line.
    ///   - expectedQuery: Parameters the request must hold.
    @Test(
        "Decodes the query as a URL form",
        arguments: [
            ("/", []),
            ("/?", []),
            ("/?&&", []),
            ("/?a", [HTTPQueryParameter(name: "a", value: "")]),
            ("/?a=", [HTTPQueryParameter(name: "a", value: "")]),
            ("/?=1", [HTTPQueryParameter(name: "", value: "1")]),
            ("/?a=1&&a=2", [HTTPQueryParameter(name: "a", value: "1"), HTTPQueryParameter(name: "a", value: "2")]),
            ("/?a=1=2", [HTTPQueryParameter(name: "a", value: "1=2")]),
            ("/?a+b=%2B+c", [HTTPQueryParameter(name: "a b", value: "+ c")]),
            ("/?caf%C3%A9=%c3%a9", [HTTPQueryParameter(name: "café", value: "é")]),
            ("/?a=%EF%BB%BFx", [HTTPQueryParameter(name: "a", value: "\u{FEFF}x")]),
            ("/?a=1?b/c", [HTTPQueryParameter(name: "a", value: "1?b/c")]),
        ] as [(String, [HTTPQueryParameter])]
    )
    func decodesQuery(target: String, expectedQuery: [HTTPQueryParameter]) throws {
        let request = try HTTPRequest(parsingHead: Data("GET \(target) HTTP/1.1".utf8))

        #expect(request.query == expectedQuery)
    }

    /// Verifies that a query is refused as malformed (400) when a `%` lacks
    /// two hex digits or the decoded bytes are not UTF-8, in a name or a value,
    /// even after a valid parameter. A sign is not a hex digit.
    ///
    /// - Parameter target: Request target of a `GET` request line.
    @Test(
        "Rejects a query with a broken percent escape or invalid UTF-8",
        arguments: [
            "/?a=%zz",
            "/?a=%",
            "/?a=%2",
            "/?a=%-1",
            "/?a=%+1",
            "/?%zz=1",
            "/?a=1&b=%zz",
            "/?a=%FF",
            "/?a=%C3",
            "/?a=%C0%AF",
            "/?a=%ED%A0%80",
        ]
    )
    func rejectsUndecodableQuery(target: String) {
        #expect(throws: HTTPRequestError.malformedRequest) {
            try HTTPRequest(parsingHead: Data("GET \(target) HTTP/1.1".utf8))
        }
    }

    /// Verifies that methods compare case-sensitively, as HTTP defines, so
    /// `get` does not reach routes registered for `GET`.
    @Test("Keeps the method token exactly, so a lower-case get is not GET")
    func keepsMethodCase() throws {
        let request = try HTTPRequest(parsingHead: Data("get / HTTP/1.1".utf8))

        #expect(request.method == HTTPMethod(token: "get"))
        #expect(request.method != .get)
    }

    /// Verifies that every HTTP/1 minor version is served.
    ///
    /// - Parameter version: HTTP-version field of the request line.
    @Test("Accepts every HTTP/1 minor version", arguments: ["HTTP/1.0", "HTTP/1.1", "HTTP/1.9"])
    func acceptsHTTP1Versions(version: String) throws {
        let request = try HTTPRequest(parsingHead: Data("GET / \(version)".utf8))

        #expect(request == HTTPRequest(method: .get, path: "/", query: []))
    }

    /// Verifies that a well-formed version other than HTTP/1 is refused as
    /// unsupported (505) rather than malformed (400).
    ///
    /// - Parameter version: HTTP-version field of the request line.
    @Test("Rejects a well-formed version with another major version", arguments: ["HTTP/0.9", "HTTP/2.0"])
    func rejectsOtherMajorVersions(version: String) {
        #expect(throws: HTTPRequestError.unsupportedVersion) {
            try HTTPRequest(parsingHead: Data("GET / \(version)".utf8))
        }
    }

    /// Verifies that a request line is refused as malformed when it has
    /// missing or extra parts, doubled spaces, a target that is not origin-form,
    /// an invalid method token, an incomplete or lower-case version, or a
    /// control character.
    ///
    /// - Parameter requestLine: Line placed before a valid header line.
    @Test(
        "Rejects a request line that is not method, origin-form target, and version",
        arguments: [
            "",
            "GET /",
            "GET  / HTTP/1.1",
            "GET / HTTP/1.1 extra",
            "GET * HTTP/1.1",
            "GET http://localhost/ HTTP/1.1",
            "G(T / HTTP/1.1",
            "GET / HTTP/1",
            "GET / http/1.1",
            "GET /\t HTTP/1.1",
        ]
    )
    func rejectsMalformedRequestLines(requestLine: String) {
        #expect(throws: HTTPRequestError.malformedRequest) {
            try HTTPRequest(parsingHead: Data("\(requestLine)\r\nHost: localhost".utf8))
        }
    }

    /// Verifies that bytes outside printable ASCII are refused even when they
    /// form valid UTF-8.
    @Test("Rejects a request line that holds a non-ASCII byte")
    func rejectsNonASCIIBytes() {
        let head = Data("GET /caf".utf8) + Data([0xC3, 0xA9]) + Data(" HTTP/1.1".utf8)

        #expect(throws: HTTPRequestError.malformedRequest) {
            try HTTPRequest(parsingHead: head)
        }
    }
}

/// Checks where a request head ends in received bytes and the inclusive size
/// limit on it.
@Suite("Finding the request head in received bytes")
struct RequestHeadFramingTests {
    /// Verifies that an incomplete head asks for more bytes instead of failing.
    @Test("Waits for more bytes until the empty line arrives")
    func waitsForEmptyLine() throws {
        let receivedBytes = Data("GET / HTTP/1.1\r\nHost: localhost\r\n".utf8)

        #expect(try findRequestHead(in: receivedBytes) == nil)
    }

    /// Verifies that the head stops before the empty line, and that body bytes
    /// received with it are not part of it.
    @Test("Returns the head without the empty line and ignores the bytes after it")
    func returnsHeadWithoutBody() throws {
        let receivedBytes = Data("GET / HTTP/1.1\r\nHost: localhost\r\n\r\nbody".utf8)

        #expect(try findRequestHead(in: receivedBytes) == Data("GET / HTTP/1.1\r\nHost: localhost".utf8))
    }

    /// Verifies that the size limit is inclusive: a head of exactly
    /// ``maximumRequestHeadByteCount`` bytes is accepted.
    @Test("Accepts a head of exactly the maximum size")
    func acceptsMaximumSizeHead() throws {
        let head = buildHead(byteCount: maximumRequestHeadByteCount)

        #expect(try findRequestHead(in: head + emptyLine) == head)
    }

    /// Verifies that a complete head one byte over the limit is refused as too
    /// large (431).
    @Test("Rejects a complete head one byte over the maximum size")
    func rejectsCompleteOversizedHead() {
        let head = buildHead(byteCount: maximumRequestHeadByteCount + 1)

        #expect(throws: HTTPRequestError.requestHeadTooLarge) {
            try findRequestHead(in: head + emptyLine)
        }
    }

    /// Verifies that a maximum-size head still waiting for the last byte of its
    /// empty line is not refused early.
    @Test("Keeps waiting when a maximum-size head lacks only the last byte of its empty line")
    func waitsForLastByteOfMaximumSizeHead() throws {
        let head = buildHead(byteCount: maximumRequestHeadByteCount)

        #expect(try findRequestHead(in: head + emptyLine.dropLast()) == nil)
    }

    /// Verifies that a head without its empty line is refused as soon as it
    /// can no longer fit, without waiting for more bytes.
    @Test("Rejects an unfinished head once it can no longer end within the maximum size")
    func rejectsUnfinishedOversizedHead() {
        let head = buildHead(byteCount: maximumRequestHeadByteCount + 1)

        #expect(throws: HTTPRequestError.requestHeadTooLarge) {
            try findRequestHead(in: head + emptyLine.dropLast())
        }
    }
}
