/// Answers the readiness probe for voice.
extension Route {
    /// `GET /health`: answers `200 OK` with `ok` once the models are loaded,
    /// and `503 Service Unavailable` until they are.
    ///
    /// The backend sends this request before every speech, and rejects the
    /// speech with its own error when voice does not answer `200`. Lys's
    /// desktop asks the same route to show the voice card's state. The
    /// response carries no health detail beyond the one word.
    ///
    /// - Parameter isReady: Reads whether the models are loaded.
    static func health(isReady: @escaping @Sendable () -> Bool) -> Route {
        Route(method: .get, path: "/health") { _ in
            isReady()
                ? HTTPResponse(status: .ok, text: "ok\n")
                : HTTPResponse(status: .serviceUnavailable, text: "not ready\n")
        }
    }
}
