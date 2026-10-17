import Foundation
import Testing
@testable import vmo

/// Fields the dummy document must contain, decoded independently of
/// ``DummyJSONDocument`` so the test does not reuse the production type.
private struct DecodedDummyDocument: Decodable, Equatable {
    /// Expected description.
    let message: String
    /// Expected integers, in order.
    let items: [Int]
    /// Expected Boolean.
    let success: Bool
}

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

    /// Verifies that `GET /dummy-json` sends exactly the documented fields,
    /// with their values, as JSON.
    @Test("GET /dummy-json answers the dummy document as JSON")
    func answersDummyJSON() async throws {
        let router = try Router(routes: [.dummyJSON])

        let response = await router.handleRequest(HTTPRequest(method: .get, path: "/dummy-json", query: []))

        #expect(response.status == .ok)
        #expect(response.headerFields == [HTTPHeaderField(name: "Content-Type", value: "application/json; charset=utf-8")])
        let jsonObject = try #require(try JSONSerialization.jsonObject(with: response.body) as? [String: Any])
        #expect(Set(jsonObject.keys) == ["items", "message", "success"])
        let document = try JSONDecoder().decode(DecodedDummyDocument.self, from: response.body)
        #expect(document == DecodedDummyDocument(message: "This is dummy JSON", items: [1, 2, 3], success: true))
    }
}
