extension Route {
    /// `GET /`: answers with the plain-text greeting `Hello, world!`.
    static let helloWorld = Route(method: .get, path: "/") { _ in
        HTTPResponse(status: .ok, text: "Hello, world!\n")
    }
}
