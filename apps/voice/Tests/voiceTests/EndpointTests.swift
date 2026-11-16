import Foundation
import Testing
@testable import voice

/// Checks the health endpoint voice registers, through the router as the
/// server calls it.
@Suite("Endpoints")
struct EndpointTests {
    /// Verifies `GET /health` answers `200 ok` while the models are loaded.
    @Test("GET /health answers ok when the models are ready")
    func answersOkWhenReady() async throws {
        let router = try Router(routes: [.health(isReady: { true })])

        let response = await router.handleRequest(HTTPRequest(method: .get, path: "/health", query: []))

        #expect(response.status == .ok)
        #expect(response.headerFields == [HTTPHeaderField(name: "Content-Type", value: "text/plain; charset=utf-8")])
        #expect(response.body == Data("ok\n".utf8))
    }

    /// Verifies `GET /health` answers `503` while the models are not loaded
    /// yet, so the backend reports voice as not ready.
    @Test("GET /health answers service unavailable until the models are ready")
    func answersUnavailableUntilReady() async throws {
        let router = try Router(routes: [.health(isReady: { false })])

        let response = await router.handleRequest(HTTPRequest(method: .get, path: "/health", query: []))

        #expect(response.status == .serviceUnavailable)
        #expect(response.body == Data("not ready\n".utf8))
    }
}
