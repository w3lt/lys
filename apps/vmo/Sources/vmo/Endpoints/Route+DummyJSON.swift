/// Fixed sample document that ``Route/dummyJSON`` returns.
struct DummyJSONDocument: Encodable, Sendable {
    /// Description of the document.
    let message: String
    /// Sample integers, in order.
    let items: [Int]
    /// Sample Boolean, always `true`.
    let success: Bool
}

extension Route {
    /// `GET /dummy-json`: answers with a fixed ``DummyJSONDocument`` encoded as
    /// JSON.
    static let dummyJSON = Route(method: .get, path: "/dummy-json") { _ in
        let document = DummyJSONDocument(message: "This is dummy JSON", items: [1, 2, 3], success: true)
        return try HTTPResponse(status: .ok, json: document)
    }
}
