import Foundation

/// Media type of every plain-text response.
private let plainTextContentType = "text/plain; charset=utf-8"

/// One response header field.
struct HTTPHeaderField: Equatable, Sendable {
    /// Field name, such as `Content-Type`.
    let name: String
    /// Field value.
    let value: String
}

/// One complete HTTP response, before it is written to a connection.
///
/// Responses are created only through the initializers in this file. They set
/// every header field from fixed media types and method tokens, so no field
/// holds a line break or repeats the `Content-Length` and `Connection` fields
/// that ``buildWireMessage()`` adds.
struct HTTPResponse: Equatable, Sendable {
    /// Status sent on the status line.
    let status: HTTPStatus
    /// Header fields sent after the status line, in this order.
    let headerFields: [HTTPHeaderField]
    /// Complete response content.
    let body: Data

    /// Creates a response from its parts.
    ///
    /// - Parameters:
    ///   - status: Status to send.
    ///   - headerFields: Fields chosen by one of the other initializers.
    ///   - body: Complete response content.
    private init(status: HTTPStatus, headerFields: [HTTPHeaderField], body: Data) {
        self.status = status
        self.headerFields = headerFields
        self.body = body
    }
}

extension HTTPResponse {
    /// Creates a plain-text response.
    ///
    /// - Parameters:
    ///   - status: Status to send.
    ///   - text: Complete body, sent as UTF-8.
    init(status: HTTPStatus, text: String) {
        let contentType = HTTPHeaderField(name: "Content-Type", value: plainTextContentType)
        self.init(status: status, headerFields: [contentType], body: Data(text.utf8))
    }

    /// Creates a plain-text response whose body is the status reason phrase and
    /// a line feed, such as `Not Found\n`.
    ///
    /// - Parameter status: Status to send.
    init(status: HTTPStatus) {
        self.init(status: status, text: "\(status.reasonPhrase)\n")
    }

    /// Creates a JSON response.
    ///
    /// Object keys are sorted, so the body does not depend on property or
    /// dictionary order. The output is indented for reading.
    ///
    /// - Parameters:
    ///   - status: Status to send.
    ///   - value: Value to encode as the body.
    /// - Throws: `EncodingError` when `value` cannot be represented as JSON.
    init(status: HTTPStatus, json value: some Encodable) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let body = try encoder.encode(value)
        let contentType = HTTPHeaderField(name: "Content-Type", value: "application/json; charset=utf-8")
        self.init(status: status, headerFields: [contentType], body: body)
    }

    /// Creates the `405 Method Not Allowed` response for a path that other
    /// methods can use.
    ///
    /// - Parameter allowedMethods: Methods the path accepts, sent in this order
    ///   in the `Allow` header.
    init(allowedMethods: [HTTPMethod]) {
        let status = HTTPStatus.methodNotAllowed
        let contentType = HTTPHeaderField(name: "Content-Type", value: plainTextContentType)
        let allow = HTTPHeaderField(name: "Allow", value: allowedMethods.map(\.token).joined(separator: ", "))
        let body = Data("\(status.reasonPhrase)\n".utf8)
        self.init(status: status, headerFields: [contentType, allow], body: body)
    }

    /// Creates the error response for a request that cannot reach a route.
    ///
    /// - Parameter requestError: Reason the request was rejected.
    init(requestError: HTTPRequestError) {
        switch requestError {
        case .malformedRequest:
            self.init(status: .badRequest)
        case .requestHeadTooLarge:
            self.init(status: .requestHeaderFieldsTooLarge)
        case .unsupportedVersion:
            self.init(status: .httpVersionNotSupported)
        }
    }

    /// Builds the HTTP/1.1 message for this response.
    ///
    /// - Returns: The status line, ``headerFields`` in order, `Content-Length`
    ///   with the body's byte count, `Connection: close`, an empty line, and
    ///   ``body``.
    func buildWireMessage() -> Data {
        let statusLine = "HTTP/1.1 \(status.rawValue) \(status.reasonPhrase)\r\n"
        let headerLines = headerFields.map { "\($0.name): \($0.value)\r\n" }.joined()
        let framingLines = "Content-Length: \(body.count)\r\nConnection: close\r\n\r\n"
        return Data((statusLine + headerLines + framingLines).utf8) + body
    }
}
