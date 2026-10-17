extension Route {
    /// `GET /web/read-page?url=…`: reads the page at `url` in a micro VM.
    ///
    /// For now it only echoes `url`. Reading the page in a VM is the remaining
    /// work of #190; until then `vmManager` is not used.
    ///
    /// - Parameter vmManager: Provides the VMs that pages are read in.
    /// - Returns: The route. It answers `400 Bad Request` when `url` is
    ///   missing.
    static func readPage(vmManager: VmManager) -> Route {
        Route(method: .get, path: "/web/read-page") { request in
            handleReadPageRequest(request, vmManager)
        }
    }
}

private func handleReadPageRequest(_ request: HTTPRequest, _ vmManager: VmManager) -> HTTPResponse {
    if let urlValue = request.query.first(where: { $0.name == "url" })?.value {
        return HTTPResponse(status: .ok, text: "Would read \(urlValue)\n")
    }
    
    
    
    return HTTPResponse(status: .badRequest, text: "url query param is missing.\n")
}
