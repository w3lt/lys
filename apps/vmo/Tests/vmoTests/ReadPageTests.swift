import Foundation
import Testing
@testable import vmo

/// Checks `GET /web/read-page` through the router, as the server calls it.
@Suite("Read-page endpoint")
struct ReadPageTests {
    /// Directory holding this test's image store.
    private let containerRoot: TemporaryContainerRoot

    /// Creates this test's container directory.
    ///
    /// - Throws: The file system's error when the directory can't be created.
    init() throws {
        containerRoot = try TemporaryContainerRoot()
    }

    /// Builds a router with only the read-page route, over a VM manager that
    /// creates no VM.
    ///
    /// - Returns: The router.
    /// - Throws: Containerization's error when the image store can't be
    ///   created.
    private func buildRouter() throws -> Router {
        let vmManager = VmManager(containerManager: try containerRoot.createContainerManager())
        return try Router(routes: [.readPage(vmManager: vmManager)])
    }

    /// Verifies the status and text of a request that names a page.
    @Test("GET /web/read-page?url= answers which page it would read")
    func answersRequestedUrl() async throws {
        let router = try buildRouter()
        let query = [HTTPQueryParameter(name: "url", value: "https://example.com/")]

        let response = await router.handleRequest(HTTPRequest(method: .get, path: "/web/read-page", query: query))

        #expect(response.status == .ok)
        #expect(response.body == Data("Would read https://example.com/\n".utf8))
    }

    /// Verifies the status and text of a request that names no page.
    @Test("GET /web/read-page without url answers 400 Bad Request")
    func rejectsMissingUrl() async throws {
        let router = try buildRouter()

        let response = await router.handleRequest(HTTPRequest(method: .get, path: "/web/read-page", query: []))

        #expect(response.status == .badRequest)
        #expect(response.body == Data("url query param is missing.\n".utf8))
    }
}
