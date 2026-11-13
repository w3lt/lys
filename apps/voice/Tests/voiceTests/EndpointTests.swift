import Foundation
import Testing
@testable import voice

/// Checks the endpoint voice registers, through the router as the server calls
/// it.
@Suite("Endpoints")
struct EndpointTests {
    /// Verifies the status, content type, and exact object of `GET /`.
    @Test("GET / answers Hello World as JSON")
    func answersHelloWorld() async throws {
        let router = try Router(routes: [.helloWorld])

        let response = await router.handleRequest(HTTPRequest(method: .get, path: "/", query: []))

        #expect(response.status == .ok)
        #expect(response.headerFields == [HTTPHeaderField(name: "Content-Type", value: "application/json; charset=utf-8")])
        let body = try JSONDecoder().decode([String: String].self, from: response.body)
        #expect(body == ["text": "Hello World"])
    }
}
