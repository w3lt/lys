import Foundation

/// Longest a read may take, from when vmo accepts the request until the
/// reader exits. Creating and booting the VM count toward it.
private let readPageTimeLimit = Duration.seconds(30)

extension Route {
    /// `GET /web/read-page?url=…`: reads the page at `url` in a micro VM of
    /// its own, which is deleted before the response is sent.
    ///
    /// The read takes at most 30 seconds, unless creating and booting the VM
    /// alone take longer; ``readPageInVm(_:_:deadline:)`` describes how the
    /// VM is run and deleted.
    ///
    /// - Parameter vmManager: Creates and deletes the VMs pages are read in.
    /// - Returns: The route. It answers `400 Bad Request` when `url` is
    ///   missing or ``parsePageUrl(_:)`` rejects it, the response of
    ///   ``buildReadPageResponse(for:)`` when the read ends, and `500 Internal
    ///   Server Error` when vmo can't create, start, wait for, or delete the
    ///   VM.
    static func readPage(vmManager: VmManager) -> Route {
        Route(method: .get, path: "/web/read-page") { request in
            try await handleReadPageRequest(request, vmManager)
        }
    }
}

/// Body of a `200 OK` read-page response.
private struct ReadPageResult: Encodable {
    /// The HTML the reader wrote, decoded as UTF-8. Invalid bytes, such as a
    /// character cut at the end of truncated HTML, become U+FFFD.
    let html: String
    /// Whether the reader wrote more than ``maximumKeptStreamByteCount``
    /// bytes, so that `html` holds only the first ones.
    let isTruncated: Bool
}

/// Body of a `502 Bad Gateway` read-page response.
private struct ReadPageFailure: Encodable {
    /// The reader's exit code, which isn't 0.
    let exitCode: Int32
    /// What the reader wrote to standard error, decoded as UTF-8, such as
    /// `Error: Chromium returned empty HTML`. At most
    /// ``maximumKeptStreamByteCount`` bytes of it are kept.
    let error: String
}

/// Reads the page a request names and answers with how the read ended.
///
/// - Parameters:
///   - request: A `GET /web/read-page` request.
///   - vmManager: Creates and deletes the VM the page is read in.
/// - Returns: `400 Bad Request` as plain text when `url` is missing or isn't
///   a page URL, without creating a VM; otherwise the response of
///   ``buildReadPageResponse(for:)``.
/// - Throws: The errors of ``readPageInVm(_:_:deadline:)`` and
///   ``buildReadPageResponse(for:)``.
private func handleReadPageRequest(_ request: HTTPRequest, _ vmManager: VmManager) async throws -> HTTPResponse {
    guard let urlValue = request.query.first(where: { $0.name == "url" })?.value else {
        return HTTPResponse(status: .badRequest, text: "url query param is missing.\n")
    }
    guard let url = parsePageUrl(urlValue) else {
        return HTTPResponse(status: .badRequest, text: "url must be an absolute http or https URL with a host.\n")
    }
    let outcome = try await readPageInVm(url, vmManager, deadline: .now + readPageTimeLimit)
    return try buildReadPageResponse(for: outcome)
}

/// URL of a page to read, as the caller sent it, checked to be an absolute
/// `http` or `https` URL with a host.
///
/// Only ``parsePageUrl(_:)`` creates one, so holding one means the check
/// passed.
struct PageUrl: Equatable, Sendable {
    /// The URL's text, unchanged. The reader loads it as given, so the page
    /// it reads is the one the caller validated and cites.
    let text: String

    /// Wraps text that ``parsePageUrl(_:)`` checked.
    ///
    /// - Parameter text: The checked URL text.
    fileprivate init(text: String) {
        self.text = text
    }
}

/// Parses the URL of a page to read.
///
/// The reader accepts only URLs that start with `http://` or `https://`, so
/// the scheme must be lower case. The text is checked with Foundation's URL
/// parser but not rewritten: Foundation would encode every `%` again in a
/// path or query that also holds a character it doesn't allow, such as `[` or
/// `|`, and the reader would then load another page.
///
/// - Parameter value: The decoded `url` query parameter.
/// - Returns: The URL, with `value` as its text, when `value` is an absolute
///   `http` or `https` URL with a non-empty host; otherwise `nil`.
func parsePageUrl(_ value: String) -> PageUrl? {
    guard let url = URL(string: value), let scheme = url.scheme, ["http", "https"].contains(scheme) else {
        return nil
    }
    guard let host = url.host(percentEncoded: true), !host.isEmpty else {
        return nil
    }
    return PageUrl(text: value)
}

/// Builds the response for a read that ended.
///
/// - Parameter outcome: How the read ended.
/// - Returns: `200 OK` with a JSON ``ReadPageResult`` when the reader exited
///   with 0. `502 Bad Gateway` with a JSON ``ReadPageFailure`` when it exited
///   with another code, because it couldn't read the page. `504 Gateway
///   Timeout` as plain text when the time limit passed first.
/// - Throws: `EncodingError` when the body can't be encoded as JSON.
func buildReadPageResponse(for outcome: ReadPageOutcome) throws -> HTTPResponse {
    switch outcome {
    case .readerExited(let output) where output.exitCode == 0:
        let html = String(decoding: output.stdout.bytes, as: UTF8.self)
        return try HTTPResponse(status: .ok, json: ReadPageResult(html: html, isTruncated: output.stdout.isTruncated))
    case .readerExited(let output):
        let error = String(decoding: output.stderr.bytes, as: UTF8.self)
        return try HTTPResponse(status: .badGateway, json: ReadPageFailure(exitCode: output.exitCode, error: error))
    case .timedOut:
        let seconds = readPageTimeLimit.components.seconds
        return HTTPResponse(status: .gatewayTimeout, text: "The page was not read within \(seconds) seconds.\n")
    }
}
