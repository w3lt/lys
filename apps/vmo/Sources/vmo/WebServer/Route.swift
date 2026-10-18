/// One endpoint: the method and path it answers and the closure that answers
/// it.
///
/// Each endpoint is declared in `Endpoints/`: a static member when it needs
/// nothing, or a static factory that receives the services it uses. The entry
/// point builds every route from its services and registers it by passing it
/// to ``Router/init(routes:)``.
struct Route: Sendable {
    /// Method the route answers.
    let method: HTTPMethod
    /// Path the route answers, compared exactly with ``HTTPRequest/path``.
    let path: String
    /// Answers one request whose method and path match this route.
    ///
    /// It can run concurrently for concurrent requests. A thrown error becomes a
    /// `500 Internal Server Error` response; the error is logged and never sent
    /// to the client. Task cancellation means the client connection is closing,
    /// so no response will be delivered.
    let handleRequest: @Sendable (HTTPRequest) async throws -> HTTPResponse
}
