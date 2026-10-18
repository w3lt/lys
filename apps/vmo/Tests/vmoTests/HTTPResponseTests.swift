import Foundation
import Testing
@testable import vmo

/// Value whose properties are declared in reverse alphabetical order, so
/// sorted JSON keys differ from declaration order.
private struct ReverseOrderedFixture: Encodable {
    /// Declared first, sorts last.
    let zebra: Int
    /// Declared last, sorts first.
    let apple: Int
}

/// Checks the responses this server builds and their bytes on the wire.
@Suite("Building responses")
struct HTTPResponseTests {
    /// Verifies the exact bytes sent for a plain-text response, including the
    /// header order and the framing fields every response carries.
    @Test("Frames a response as status line, header fields, Content-Length, Connection: close, and body")
    func framesWireMessage() {
        let message = HTTPResponse(status: .ok, text: "Hello, world!\n").buildWireMessage()

        let expectedMessage = "HTTP/1.1 200 OK\r\n"
            + "Content-Type: text/plain; charset=utf-8\r\n"
            + "Content-Length: 14\r\n"
            + "Connection: close\r\n"
            + "\r\n"
            + "Hello, world!\n"
        #expect(message == Data(expectedMessage.utf8))
    }

    /// Verifies that Content-Length counts UTF-8 bytes, so one two-byte
    /// character is framed as 2.
    @Test("Counts Content-Length in bytes rather than characters")
    func countsContentLengthInBytes() {
        let message = HTTPResponse(status: .ok, text: "é").buildWireMessage()

        #expect(String(decoding: message, as: UTF8.self).contains("\r\nContent-Length: 2\r\n"))
    }

    /// Verifies that a status-only response explains itself with its reason
    /// phrase.
    @Test("Uses the reason phrase as the body of a status-only response")
    func usesReasonPhraseAsBody() {
        let response = HTTPResponse(status: .notFound)

        #expect(response.status == .notFound)
        #expect(response.body == Data("Not Found\n".utf8))
    }

    /// Verifies that a 405 response lists the allowed methods in the order
    /// given.
    @Test("Lists the allowed methods in order in the Allow header of a 405 response")
    func listsAllowedMethods() {
        let response = HTTPResponse(allowedMethods: [.get, HTTPMethod(token: "DELETE")])

        #expect(response.status == .methodNotAllowed)
        #expect(response.headerFields.contains(HTTPHeaderField(name: "Allow", value: "GET, DELETE")))
    }

    /// Verifies the status sent for each kind of rejected request.
    ///
    /// - Parameters:
    ///   - requestError: Reason the request was rejected.
    ///   - expectedStatus: Status the client must receive.
    @Test(
        "Answers each request error with its status",
        arguments: [
            (HTTPRequestError.malformedRequest, HTTPStatus.badRequest),
            (HTTPRequestError.requestHeadTooLarge, HTTPStatus.requestHeaderFieldsTooLarge),
            (HTTPRequestError.unsupportedVersion, HTTPStatus.httpVersionNotSupported),
        ]
    )
    func answersRequestErrors(requestError: HTTPRequestError, expectedStatus: HTTPStatus) {
        #expect(HTTPResponse(requestError: requestError).status == expectedStatus)
    }

    /// Verifies that JSON bodies have a stable key order and are labeled as
    /// UTF-8 JSON.
    @Test("Encodes JSON with sorted keys and a JSON content type")
    func encodesJSONWithSortedKeys() throws {
        let response = try HTTPResponse(status: .ok, json: ReverseOrderedFixture(zebra: 1, apple: 2))

        let body = String(decoding: response.body, as: UTF8.self)
        let appleKey = try #require(body.range(of: "\"apple\""))
        let zebraKey = try #require(body.range(of: "\"zebra\""))
        #expect(appleKey.lowerBound < zebraKey.lowerBound)
        #expect(response.headerFields == [HTTPHeaderField(name: "Content-Type", value: "application/json; charset=utf-8")])
    }
}
