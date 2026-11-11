extension Route {
    /// `GET /health`: answers `200 OK` with the plain-text body `ok`.
    ///
    /// vmo listens only after its images are pulled and its services have
    /// started, so any answer means it is ready to read pages. Lys's desktop
    /// and backend send this request to decide whether `read_page` can run.
    static let health = Route(method: .get, path: "/health") { _ in
        HTTPResponse(status: .ok, text: "ok\n")
    }
}
