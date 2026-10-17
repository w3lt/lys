extension Route {
    static let readPage = Route(method: .get, path: "/web/read-page") { request in
        handleReadPageRequest(request)
    }
}

private func handleReadPageRequest(_ request: HTTPRequest) -> HTTPResponse {
    if let urlValue = request.query.first(where: { $0.name == "url" })?.value {
        return HTTPResponse(status: .ok, text: "Would read \(urlValue)\n")
    }
    
    return HTTPResponse(status: .badRequest, text: "url query param is missing.\n")
}
