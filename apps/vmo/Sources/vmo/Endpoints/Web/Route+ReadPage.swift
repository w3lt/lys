private struct ReadPageResult : Encodable {
    let output: String
    let error: String
    let exitCode: Int32
}

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
        Route(method: .get, path: "/web/read-page") { request async in
            do {
                return try await handleReadPageRequest(request, vmManager)
            } catch {
                return HTTPResponse(status: .internalServerError)
            }
        }
    }
}

private func handleReadPageRequest(_ request: HTTPRequest, _ vmManager: VmManager) async throws -> HTTPResponse {
    guard let urlValue = request.query.first(where: { $0.name == "url" })?.value else {
        return HTTPResponse(status: .badRequest, text: "url query param is missing.\n")
    }
    
    let vmId = try await vmManager.createVm(command: ["/bin/echo", urlValue])
    try await vmManager.startVm(containerId: vmId)
    let result = try await vmManager.waitForCommandExit(containerId: vmId)
    
    let ouput = String(decoding: result.stdout, as: UTF8.self)
    let error = String(decoding: result.stderr, as: UTF8.self)
    
    return try HTTPResponse(
        status: .ok,
        json: ReadPageResult(
            output: ouput,
            error: error,
            exitCode: result.exitCode
        )
    )
}
