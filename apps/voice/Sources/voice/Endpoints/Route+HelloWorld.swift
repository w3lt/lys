/// JSON body returned by the hello-world endpoint.
private struct HelloWorldBody: Encodable {
    /// Greeting text.
    let text: String
}

extension Route {
    /// `GET /`: answers `200 OK` with the JSON object
    /// `{"text": "Hello World"}`.
    static let helloWorld = Route(method: .get, path: "/") { _ in
        try HTTPResponse(status: .ok, json: HelloWorldBody(text: "Hello World"))
    }
}
