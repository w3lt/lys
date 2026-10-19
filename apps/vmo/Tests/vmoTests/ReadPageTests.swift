import Foundation
import Testing
@testable import vmo

/// Body of a `200 OK` read-page response, as a client decodes it.
private struct ReadPageResultBody: Decodable, Equatable {
    /// The page's HTML.
    let html: String
    /// Whether the HTML was cut.
    let isTruncated: Bool
}

/// Body of a `502 Bad Gateway` read-page response, as a client decodes it.
private struct ReadPageFailureBody: Decodable, Equatable {
    /// The reader's exit code.
    let exitCode: Int32
    /// What the reader wrote to standard error.
    let error: String
}

/// Checks `GET /web/read-page` without a VM: through the router up to the VM
/// manager, and the responses built from how a read ended.
///
/// Reading a page needs the read-page image, a Linux kernel, and
/// Virtualization support, so no test here reads one.
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

    /// Builds a router with only the read-page route, over a closed VM
    /// manager: a request that reaches it fails before any VM work.
    ///
    /// - Returns: The router.
    /// - Throws: Containerization's error when the image store can't be
    ///   created.
    private func buildRouter() async throws -> Router {
        let vmManager = VmManager(containerManager: try containerRoot.createContainerManager())
        try await vmManager.close()
        return try Router(routes: [.readPage(vmManager: vmManager)])
    }

    /// Builds the read-page request for a `url` parameter.
    ///
    /// - Parameter url: Value of the `url` parameter.
    /// - Returns: The request.
    private func buildRequest(url: String) -> HTTPRequest {
        HTTPRequest(method: .get, path: "/web/read-page", query: [HTTPQueryParameter(name: "url", value: url)])
    }

    /// Verifies the status and text of a request that names no page.
    @Test("GET /web/read-page without url answers 400 Bad Request")
    func rejectsMissingUrl() async throws {
        let router = try await buildRouter()

        let response = await router.handleRequest(HTTPRequest(method: .get, path: "/web/read-page", query: []))

        #expect(response.status == .badRequest)
        #expect(response.body == Data("url query param is missing.\n".utf8))
    }

    /// Verifies that values the reader can't read are rejected before the VM
    /// manager is asked for a VM; asking the closed manager would answer 500.
    @Test(
        "GET /web/read-page with a url that isn't an absolute http or https URL answers 400 Bad Request",
        arguments: [
            "",
            "example.com",
            "/relative/path",
            "ftp://example.com/",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "HTTPS://example.com/",
            "http://",
            "http:example.com",
        ]
    )
    func rejectsNonPageUrl(url: String) async throws {
        let router = try await buildRouter()

        let response = await router.handleRequest(buildRequest(url: url))

        #expect(response.status == .badRequest)
        #expect(response.body == Data("url must be an absolute http or https URL with a host.\n".utf8))
    }

    /// Verifies that a page URL reaches the VM manager, whose failure the
    /// router answers as a server error.
    @Test("GET /web/read-page answers 500 Internal Server Error when no VM can be created")
    func failsWithoutVm() async throws {
        let router = try await buildRouter()

        let response = await router.handleRequest(buildRequest(url: "https://example.com/"))

        #expect(response.status == .internalServerError)
    }

    /// Verifies which URLs are accepted, and that the reader gets their text
    /// as the caller sent it. Foundation would encode `%` again in a
    /// component that also holds a character it doesn't allow, such as `[`
    /// or `|`, so the reader would load another page than the one cited.
    @Test(
        "Parses absolute http and https URLs and keeps their text unchanged",
        arguments: [
            "https://example.com/",
            "http://example.com:8080/a?b=c#d",
            "https://example.com/a b",
            "https://example.com/search?q=hello%20world&filter[type]=article",
            "https://example.com/search?q=caf%C3%A9|th%C3%A9",
            "https://example.com/caf%C3%A9/a[1]",
            "https://example.com/a|b?q=hello%20world",
            "https://example.com/p?q=hello%20world#x|y",
            "https://example.com/%zz",
        ]
    )
    func parsesPageUrl(value: String) throws {
        let url = try #require(parsePageUrl(value))

        #expect(url.text == value)
    }

    /// Verifies the response for a reader that wrote the page's HTML.
    @Test("A reader that exits with 0 answers 200 OK with its HTML")
    func answersHtml() throws {
        let output = CommandOutput(
            stdout: CommandStreamOutput(bytes: Data("<p>Hi</p>\n".utf8), isTruncated: false),
            stderr: CommandStreamOutput(bytes: Data(), isTruncated: false),
            exitCode: 0
        )

        let response = try buildReadPageResponse(for: .readerExited(output))

        #expect(response.status == .ok)
        let body = try JSONDecoder().decode(ReadPageResultBody.self, from: response.body)
        #expect(body == ReadPageResultBody(html: "<p>Hi</p>\n", isTruncated: false))
    }

    /// Verifies that cut HTML is reported, and that a character cut in two
    /// becomes U+FFFD rather than failing the response.
    @Test("A reader whose HTML was cut answers 200 OK with the kept HTML marked truncated")
    func answersTruncatedHtml() throws {
        let cutCharacter = Data("é".utf8).prefix(1)
        let output = CommandOutput(
            stdout: CommandStreamOutput(bytes: Data("<p>caf".utf8) + cutCharacter, isTruncated: true),
            stderr: CommandStreamOutput(bytes: Data(), isTruncated: false),
            exitCode: 0
        )

        let response = try buildReadPageResponse(for: .readerExited(output))

        #expect(response.status == .ok)
        let body = try JSONDecoder().decode(ReadPageResultBody.self, from: response.body)
        #expect(body == ReadPageResultBody(html: "<p>caf\u{FFFD}", isTruncated: true))
    }

    /// Verifies the response for a reader that couldn't read the page.
    @Test("A reader that exits with another code answers 502 Bad Gateway with its exit code and error")
    func answersReaderFailure() throws {
        let output = CommandOutput(
            stdout: CommandStreamOutput(bytes: Data(), isTruncated: false),
            stderr: CommandStreamOutput(bytes: Data("Error: Chromium returned empty HTML\n".utf8), isTruncated: false),
            exitCode: 1
        )

        let response = try buildReadPageResponse(for: .readerExited(output))

        #expect(response.status == .badGateway)
        let body = try JSONDecoder().decode(ReadPageFailureBody.self, from: response.body)
        #expect(body == ReadPageFailureBody(exitCode: 1, error: "Error: Chromium returned empty HTML\n"))
    }

    /// Verifies the response for a read that ran out of time.
    @Test("A read that timed out answers 504 Gateway Timeout")
    func answersTimeout() throws {
        let response = try buildReadPageResponse(for: .timedOut)

        #expect(response.status == .gatewayTimeout)
        #expect(response.body == Data("The page was not read within 30 seconds.\n".utf8))
    }
}
