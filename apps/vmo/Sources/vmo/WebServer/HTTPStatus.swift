/// Status codes this server sends, with their RFC 9110 meanings.
enum HTTPStatus: Int, Sendable {
    /// `200 OK`: the response carries the requested representation.
    case ok = 200
    /// `400 Bad Request`: the request is not a valid HTTP/1.x request, or a
    /// route rejects its parameters.
    case badRequest = 400
    /// `404 Not Found`: the server has nothing at the request path.
    case notFound = 404
    /// `405 Method Not Allowed`: the path exists, but not for the request method.
    case methodNotAllowed = 405
    /// `431 Request Header Fields Too Large`: the request head is too long.
    case requestHeaderFieldsTooLarge = 431
    /// `500 Internal Server Error`: the server failed while answering.
    case internalServerError = 500
    /// `502 Bad Gateway`: a program the server ran to answer failed.
    case badGateway = 502
    /// `504 Gateway Timeout`: a program the server ran to answer didn't end
    /// in time.
    case gatewayTimeout = 504
    /// `505 HTTP Version Not Supported`: the request uses an HTTP major version
    /// other than 1.
    case httpVersionNotSupported = 505

    /// Reason phrase sent after the code on the status line.
    var reasonPhrase: String {
        switch self {
        case .ok: "OK"
        case .badRequest: "Bad Request"
        case .notFound: "Not Found"
        case .methodNotAllowed: "Method Not Allowed"
        case .requestHeaderFieldsTooLarge: "Request Header Fields Too Large"
        case .internalServerError: "Internal Server Error"
        case .badGateway: "Bad Gateway"
        case .gatewayTimeout: "Gateway Timeout"
        case .httpVersionNotSupported: "HTTP Version Not Supported"
        }
    }
}
