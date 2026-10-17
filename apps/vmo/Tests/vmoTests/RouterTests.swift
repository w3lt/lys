import Foundation
import Testing
@testable import vmo

/// Failure thrown by a route fixture. Its description must never reach the
/// client.
private struct RouteFixtureError: Error, CustomStringConvertible {
    /// Internal detail that a response must not disclose.
    var description: String { "internal route detail" }
}

/// Builds a route whose response names the method and path it received, so a
/// test can see which route answered.
///
/// - Parameters:
///   - method: Method the route answers.
///   - path: Path the route answers.
/// - Returns: A route that answers `200 OK` with `"<method> <path>"`.
private func buildEchoRoute(method: HTTPMethod, path: String) -> Route {
    Route(method: method, path: path) { request in
        HTTPResponse(status: .ok, text: "\(request.method.token) \(request.path)")
    }
}

/// Formats a query as `name=value` pairs joined by `&`, without encoding, so a
/// test can read which parameters a route received.
///
/// - Parameter query: Parameters a route received.
/// - Returns: The pairs in order, such as `x=1&x=2 3`.
private func formatQuery(_ query: [HTTPQueryParameter]) -> String {
    query.map { "\($0.name)=\($0.value)" }.joined(separator: "&")
}

/// Checks how the router picks a route and answers requests that no route
/// serves.
@Suite("Routing requests")
struct RouterTests {
    /// Verifies that the route registered for the request's method and path
    /// answers it.
    @Test("Answers with the route that matches both method and path")
    func answersWithMatchingRoute() async throws {
        let router = try Router(routes: [
            buildEchoRoute(method: .get, path: "/first"),
            buildEchoRoute(method: .get, path: "/second"),
        ])

        let response = await router.handleRequest(HTTPRequest(method: .get, path: "/second", query: []))

        #expect(response.status == .ok)
        #expect(response.body == Data("GET /second".utf8))
    }

    /// Verifies that a request with a query reaches the route for its path,
    /// and that the route receives every parameter in order.
    @Test("Matches on the path alone and passes the query to the route")
    func passesQueryToRoute() async throws {
        let queryEchoRoute = Route(method: .get, path: "/read") { request in
            HTTPResponse(status: .ok, text: formatQuery(request.query))
        }
        let router = try Router(routes: [queryEchoRoute])
        let query = [HTTPQueryParameter(name: "x", value: "1"), HTTPQueryParameter(name: "x", value: "2 3")]

        let response = await router.handleRequest(HTTPRequest(method: .get, path: "/read", query: query))

        #expect(response.status == .ok)
        #expect(response.body == Data("x=1&x=2 3".utf8))
    }

    /// Verifies that a path with no route is answered 404.
    @Test("Answers 404 when no route has the path")
    func answersNotFound() async throws {
        let router = try Router(routes: [buildEchoRoute(method: .get, path: "/first")])

        let response = await router.handleRequest(HTTPRequest(method: .get, path: "/missing", query: []))

        #expect(response.status == .notFound)
        #expect(response.body == Data("Not Found\n".utf8))
    }

    /// Verifies that a known path requested with another method is answered
    /// 405, listing only that path's methods in registration order.
    @Test("Answers 405 listing the path's methods in registration order when none answers the method")
    func answersMethodNotAllowed() async throws {
        let delete = HTTPMethod(token: "DELETE")
        let router = try Router(routes: [
            buildEchoRoute(method: delete, path: "/first"),
            buildEchoRoute(method: .get, path: "/second"),
            buildEchoRoute(method: .get, path: "/first"),
        ])

        let response = await router.handleRequest(HTTPRequest(method: HTTPMethod(token: "POST"), path: "/first", query: []))

        #expect(response.status == .methodNotAllowed)
        #expect(response.headerFields.contains(HTTPHeaderField(name: "Allow", value: "DELETE, GET")))
    }

    /// Verifies that a failing route is answered 500 and that the error's
    /// description is not sent to the client.
    @Test("Answers 500 without the error details when the route throws")
    func answersInternalServerError() async throws {
        let failingRoute = Route(method: .get, path: "/failing") { _ in
            throw RouteFixtureError()
        }
        let router = try Router(routes: [failingRoute])

        let response = await router.handleRequest(HTTPRequest(method: .get, path: "/failing", query: []))

        #expect(response.status == .internalServerError)
        #expect(response.body == Data("Internal Server Error\n".utf8))
    }

    /// Verifies that registering the same method and path twice fails and
    /// names the duplicate, while the same path with another method is allowed.
    @Test("Rejects two routes with the same method and path")
    func rejectsDuplicateRoutes() {
        #expect(throws: RouteRegistrationError.duplicateRoute(method: .get, path: "/first")) {
            try Router(routes: [
                buildEchoRoute(method: .get, path: "/first"),
                buildEchoRoute(method: HTTPMethod(token: "POST"), path: "/first"),
                buildEchoRoute(method: .get, path: "/first"),
            ])
        }
    }
}
