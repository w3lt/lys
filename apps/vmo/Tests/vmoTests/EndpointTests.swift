import Foundation
import Testing
@testable import vmo

/// Checks the endpoints vmo registers, through the router as the server calls
/// them.
@Suite("Endpoints")
struct EndpointTests {
    /// Verifies the status, content type, and greeting of `GET /`.
    @Test("GET / answers Hello, world! as plain text")
    func answersHelloWorld() async throws {
        let router = try Router(routes: [.helloWorld])

        let response = await router.handleRequest(HTTPRequest(method: .get, path: "/", query: []))

        #expect(response.status == .ok)
        #expect(response.headerFields == [HTTPHeaderField(name: "Content-Type", value: "text/plain; charset=utf-8")])
        #expect(response.body == Data("Hello, world!\n".utf8))
    }

    /// Verifies the status, content type, and body of `GET /health`, the route
    /// that tells a caller vmo is ready to read pages.
    @Test("GET /health answers ok as plain text")
    func answersHealth() async throws {
        let router = try Router(routes: [.health])

        let response = await router.handleRequest(HTTPRequest(method: .get, path: "/health", query: []))

        #expect(response.status == .ok)
        #expect(response.headerFields == [HTTPHeaderField(name: "Content-Type", value: "text/plain; charset=utf-8")])
        #expect(response.body == Data("ok\n".utf8))
    }
}
