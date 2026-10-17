/// Reasons a route list cannot form a ``Router``.
enum RouteRegistrationError: Error, Equatable {
    /// Two routes answer the same method and path.
    case duplicateRoute(method: HTTPMethod, path: String)
}

/// Owns a fixed route list to answer each request with its route, while
/// guaranteeing that at most one route answers any method and path.
///
/// Routing misses become `404` or `405` responses, and route failures become
/// `500` responses. Concurrency model: reentrant. The route list never changes,
/// so concurrent requests can call ``handleRequest(_:)`` at the same time.
struct Router: Sendable {
    /// Routes in registration order; no two share a method and path.
    private let routes: [Route]

    /// Creates a router for a fixed list of routes.
    ///
    /// - Parameter routes: Routes that answer requests. Their order is the
    ///   order of methods in `Allow` headers.
    /// - Throws: ``RouteRegistrationError/duplicateRoute(method:path:)`` when
    ///   two routes share a method and path.
    init(routes: [Route]) throws(RouteRegistrationError) {
        for (index, route) in routes.enumerated()
        where routes[..<index].contains(where: { isSameEndpoint($0, route) }) {
            throw .duplicateRoute(method: route.method, path: route.path)
        }
        self.routes = routes
    }

    /// Answers one request.
    ///
    /// A route error is logged with the request method and path, and its
    /// details are never sent to the client.
    ///
    /// - Parameter request: Request to answer.
    /// - Returns: The matching route's response; `404 Not Found` when no route
    ///   has the path; `405 Method Not Allowed` with an `Allow` header when
    ///   routes have the path but none answers the method; `500 Internal Server
    ///   Error` when the route throws.
    func handleRequest(_ request: HTTPRequest) async -> HTTPResponse {
        let pathRoutes = routes.filter { $0.path == request.path }
        guard !pathRoutes.isEmpty else {
            return HTTPResponse(status: .notFound)
        }
        guard let route = pathRoutes.first(where: { $0.method == request.method }) else {
            return HTTPResponse(allowedMethods: pathRoutes.map(\.method))
        }
        do {
            return try await route.handleRequest(request)
        } catch {
            print("WebServer route \(request.method.token) \(request.path) failed: \(error)")
            return HTTPResponse(status: .internalServerError)
        }
    }
}

/// Whether two routes answer the same method and path.
///
/// - Parameters:
///   - firstRoute: One registered route.
///   - secondRoute: Another registered route.
/// - Returns: `true` when a request could match both routes.
private func isSameEndpoint(_ firstRoute: Route, _ secondRoute: Route) -> Bool {
    firstRoute.method == secondRoute.method && firstRoute.path == secondRoute.path
}
