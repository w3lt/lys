/// Method token from an HTTP request line, such as `GET`.
///
/// Tokens are compared case-sensitively, as RFC 9110 requires. The set is open:
/// a request can carry any token, and each ``Route`` names the one it answers.
struct HTTPMethod: Equatable, Sendable {
    /// Token exactly as it appears on the request line.
    let token: String

    /// `GET`: retrieves the current representation of the target.
    static let get = HTTPMethod(token: "GET")
}
