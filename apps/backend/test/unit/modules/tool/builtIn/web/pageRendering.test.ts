import { describe, expect, it, vi } from "vitest"
import pageReaderExitCodes from "../../../../../../src/modules/tool/builtIn/web/page_reader_exit_codes.json" with { type: "json" }
import {
  getRenderedPage,
  MAXIMUM_PAGE_HTML_LENGTH,
  MAXIMUM_VMO_RESPONSE_BYTES,
  type PageRenderingFailure
} from "../../../../../../src/modules/tool/builtIn/web/pageRendering"
import type { HostAddressLookup } from "../../../../../../src/modules/tool/builtIn/web/webConnection"
import {
  answerWithBody,
  answerWithPage,
  buildTestPageUrl,
  buildVmoReadDependencies,
  findClosedVmoOrigin,
  listTestHostAddresses,
  startVmoServer,
  VMO_JSON_CONTENT_TYPE
} from "../../../../support/vmoServer"

/** Page every case reads unless it needs another. */
const PAGE_URL = buildTestPageUrl("https://pages.test/moths")

/** HTML of a small page. */
const PAGE_HTML =
  "<html><head><title>Moths</title></head><body><p>Moths fly at night.</p></body></html>"

/** Text vmo writes around the HTML in its JSON answer, in bytes. */
const VMO_ANSWER_FRAME_BYTES = '{"html":"","isTruncated":false}'.length

/** Lookup that fails the test if it is ever asked. */
const refuseLookup: HostAddressLookup = () => {
  throw new Error("The host was looked up")
}

/** Lookup that never answers. */
const neverAnswerLookup: HostAddressLookup = () =>
  new Promise(() => {
    // Never settles, so only Stop or the time limit ends the wait.
  })

/**
 * Builds the JSON answer of vmo whose body is exactly a number of bytes.
 *
 * @param byteCount - Bytes of the whole body; at least the frame's.
 * @returns The body, whose HTML is ASCII.
 */
function buildVmoAnswerOfBytes(byteCount: number): string {
  const html = "a".repeat(byteCount - VMO_ANSWER_FRAME_BYTES)
  return JSON.stringify({ html, isTruncated: false })
}

/**
 * Builds a failed outcome for comparison.
 *
 * @param kind - Kind of the failure.
 * @returns The failed outcome.
 */
function buildFailure(kind: PageRenderingFailure["kind"]) {
  return { status: "failed", failure: { kind } }
}

describe("getRenderedPage", () => {
  it("asks vmo's read-page route for the page's URL, form-encoded, and gives the HTML under that URL", async () => {
    const server = await startVmoServer(answerWithPage(PAGE_HTML))
    const url = buildTestPageUrl(
      "https://pages.test/moths+butterflies?q=moth wings&lang=en#part"
    )

    const result = await getRenderedPage(
      url,
      new AbortController().signal,
      buildVmoReadDependencies(server.origin)
    )

    expect(result).toEqual({
      status: "rendered",
      page: { url, html: PAGE_HTML, isTruncated: false }
    })
    expect(server.receivedRequests).toEqual([
      expect.objectContaining({
        method: "GET",
        path: "/web/read-page?url=https%3A%2F%2Fpages.test%2Fmoths%2Bbutterflies%3Fq%3Dmoth%2520wings%26lang%3Den%23part"
      })
    ])
    expect(server.receivedRequests[0]?.headers).toMatchObject({
      accept: "application/json",
      "accept-encoding": "identity"
    })
  })

  it("accepts JSON without a charset", async () => {
    const server = await startVmoServer(
      answerWithBody(
        200,
        "application/json",
        JSON.stringify({ html: PAGE_HTML, isTruncated: false })
      )
    )

    const result = await getRenderedPage(
      PAGE_URL,
      new AbortController().signal,
      buildVmoReadDependencies(server.origin)
    )

    expect(result).toMatchObject({ status: "rendered" })
  })

  it("keeps vmo's word that it cut the page", async () => {
    const server = await startVmoServer(answerWithPage(PAGE_HTML, true))

    const result = await getRenderedPage(
      PAGE_URL,
      new AbortController().signal,
      buildVmoReadDependencies(server.origin)
    )

    expect(result).toEqual({
      status: "rendered",
      page: { url: PAGE_URL, html: PAGE_HTML, isTruncated: true }
    })
  })

  it("keeps HTML of exactly the length limit whole", async () => {
    const html = "a".repeat(MAXIMUM_PAGE_HTML_LENGTH)
    const server = await startVmoServer(answerWithPage(html))

    const result = await getRenderedPage(
      PAGE_URL,
      new AbortController().signal,
      buildVmoReadDependencies(server.origin)
    )

    expect(result).toMatchObject({
      status: "rendered",
      page: { isTruncated: false }
    })
    expect(result.status === "rendered" && result.page.html).toBe(html)
  })

  it("cuts HTML one code unit over the length limit and marks it truncated", async () => {
    const html = "a".repeat(MAXIMUM_PAGE_HTML_LENGTH + 1)
    const server = await startVmoServer(answerWithPage(html))

    const result = await getRenderedPage(
      PAGE_URL,
      new AbortController().signal,
      buildVmoReadDependencies(server.origin)
    )

    expect(result).toMatchObject({
      status: "rendered",
      page: { isTruncated: true }
    })
    expect(result.status === "rendered" && result.page.html).toBe(
      html.slice(0, MAXIMUM_PAGE_HTML_LENGTH)
    )
  })

  it("cuts HTML without splitting a character", async () => {
    const html = `${"a".repeat(MAXIMUM_PAGE_HTML_LENGTH - 1)}🦋`
    const server = await startVmoServer(answerWithPage(html))

    const result = await getRenderedPage(
      PAGE_URL,
      new AbortController().signal,
      buildVmoReadDependencies(server.origin)
    )

    expect(result.status === "rendered" && result.page.html).toBe(
      "a".repeat(MAXIMUM_PAGE_HTML_LENGTH - 1)
    )
  })

  it("reads an answer of exactly the size limit", async () => {
    const server = await startVmoServer(
      answerWithBody(
        200,
        VMO_JSON_CONTENT_TYPE,
        buildVmoAnswerOfBytes(MAXIMUM_VMO_RESPONSE_BYTES)
      )
    )

    const result = await getRenderedPage(
      PAGE_URL,
      new AbortController().signal,
      buildVmoReadDependencies(server.origin)
    )

    expect(result).toMatchObject({
      status: "rendered",
      page: { isTruncated: true }
    })
  })

  it("fails as too-large, unreported, for an answer one byte over the size limit", async () => {
    const reportPageReaderFailure = vi.fn()
    const server = await startVmoServer(
      answerWithBody(
        200,
        VMO_JSON_CONTENT_TYPE,
        buildVmoAnswerOfBytes(MAXIMUM_VMO_RESPONSE_BYTES + 1)
      )
    )

    const result = await getRenderedPage(
      PAGE_URL,
      new AbortController().signal,
      buildVmoReadDependencies(server.origin, { reportPageReaderFailure })
    )

    expect(result).toEqual(buildFailure("too-large"))
    expect(reportPageReaderFailure).not.toHaveBeenCalled()
  })

  it.each([
    [
      400,
      "text/plain",
      "url must be an absolute http or https URL.\n",
      "url-refused"
    ],
    [431, "text/plain", "", "url-refused"],
    [
      502,
      VMO_JSON_CONTENT_TYPE,
      JSON.stringify({
        exitCode: 1,
        error: "Error: Chromium returned empty HTML"
      }),
      "not-loaded"
    ],
    [
      504,
      "text/plain",
      "The page was not read within 30 seconds.\n",
      "timed-out"
    ]
  ] as const)(
    "fails a %i answer as %s, unreported",
    async (status, contentType, body, kind) => {
      const reportPageReaderFailure = vi.fn()
      const server = await startVmoServer(
        answerWithBody(status, contentType, body)
      )

      const result = await getRenderedPage(
        PAGE_URL,
        new AbortController().signal,
        buildVmoReadDependencies(server.origin, { reportPageReaderFailure })
      )

      expect(result).toEqual(buildFailure(kind))
      expect(reportPageReaderFailure).not.toHaveBeenCalled()
    }
  )

  it("fails a 502 answer of a reader that exited as blockedAddress as blocked-address, unreported", async () => {
    const reportPageReaderFailure = vi.fn()
    const server = await startVmoServer(
      answerWithBody(
        502,
        VMO_JSON_CONTENT_TYPE,
        JSON.stringify({
          exitCode: pageReaderExitCodes.blockedAddress,
          error:
            "Error: Chromium did not connect to http://[::1]/: its address is blocked\n"
        })
      )
    )

    const result = await getRenderedPage(
      PAGE_URL,
      new AbortController().signal,
      buildVmoReadDependencies(server.origin, { reportPageReaderFailure })
    )

    expect(result).toEqual(buildFailure("blocked-address"))
    expect(reportPageReaderFailure).not.toHaveBeenCalled()
  })

  it.each([
    ["exit code 2, of a URL the reader refuses", 2],
    ["exit code 124, of timeout", 124],
    ["exit code 0", 0]
  ])(
    "fails a 502 answer with %s as not-loaded, unreported",
    async (_label, exitCode) => {
      const reportPageReaderFailure = vi.fn()
      const server = await startVmoServer(
        answerWithBody(
          502,
          VMO_JSON_CONTENT_TYPE,
          JSON.stringify({ exitCode, error: "Error: something failed" })
        )
      )

      const result = await getRenderedPage(
        PAGE_URL,
        new AbortController().signal,
        buildVmoReadDependencies(server.origin, { reportPageReaderFailure })
      )

      expect(result).toEqual(buildFailure("not-loaded"))
      expect(reportPageReaderFailure).not.toHaveBeenCalled()
    }
  )

  it("fails a 502 answer one byte over the size limit as not-loaded, unreported", async () => {
    const reportPageReaderFailure = vi.fn()
    const frame = JSON.stringify({
      exitCode: pageReaderExitCodes.blockedAddress,
      error: ""
    })
    const server = await startVmoServer(
      answerWithBody(
        502,
        VMO_JSON_CONTENT_TYPE,
        JSON.stringify({
          exitCode: pageReaderExitCodes.blockedAddress,
          error: "a".repeat(MAXIMUM_VMO_RESPONSE_BYTES + 1 - frame.length)
        })
      )
    )

    const result = await getRenderedPage(
      PAGE_URL,
      new AbortController().signal,
      buildVmoReadDependencies(server.origin, { reportPageReaderFailure })
    )

    expect(result).toEqual(buildFailure("not-loaded"))
    expect(reportPageReaderFailure).not.toHaveBeenCalled()
  })

  it.each([
    ["a text body", "text/plain", "Error: secret page text\n"],
    ["text that is not JSON", VMO_JSON_CONTENT_TYPE, "secret page text {"],
    [
      "an exit code that is not an integer",
      VMO_JSON_CONTENT_TYPE,
      JSON.stringify({ exitCode: "3", error: "secret page text" })
    ],
    [
      "no error text",
      VMO_JSON_CONTENT_TYPE,
      JSON.stringify({ exitCode: pageReaderExitCodes.blockedAddress })
    ],
    [
      "a key vmo does not send",
      VMO_JSON_CONTENT_TYPE,
      JSON.stringify({
        exitCode: pageReaderExitCodes.blockedAddress,
        error: "secret page text",
        html: ""
      })
    ]
  ])(
    "fails a 502 answer with %s as reader-failed and reports it without its body",
    async (_label, contentType, body) => {
      const reportPageReaderFailure = vi.fn()
      const server = await startVmoServer(
        answerWithBody(502, contentType, body)
      )

      const result = await getRenderedPage(
        PAGE_URL,
        new AbortController().signal,
        buildVmoReadDependencies(server.origin, { reportPageReaderFailure })
      )

      expect(result).toEqual(buildFailure("reader-failed"))
      expect(reportPageReaderFailure).toHaveBeenCalledTimes(1)
      const reported: unknown = reportPageReaderFailure.mock.calls[0]?.[0]
      expect(reported).toBeInstanceOf(Error)
      expect((reported as Error).message).not.toContain("secret")
    }
  )

  it.each([500, 404, 503])(
    "fails a %i answer as reader-failed and reports its status",
    async (status) => {
      const reportPageReaderFailure = vi.fn()
      const server = await startVmoServer(
        answerWithBody(status, "text/plain", "Internal failure")
      )

      const result = await getRenderedPage(
        PAGE_URL,
        new AbortController().signal,
        buildVmoReadDependencies(server.origin, { reportPageReaderFailure })
      )

      expect(result).toEqual(buildFailure("reader-failed"))
      expect(reportPageReaderFailure).toHaveBeenCalledTimes(1)
      expect(reportPageReaderFailure.mock.calls[0]?.[0]).toMatchObject({
        message: `vmo answered a page read with HTTP status ${status}`
      })
    }
  )

  it.each<[string, Readonly<Record<string, string>>]>([
    ["an HTML body", { "content-type": "text/html; charset=utf-8" }],
    [
      "JSON in another charset",
      { "content-type": "application/json; charset=iso-8859-1" }
    ],
    [
      "compressed JSON",
      { "content-type": "application/json", "content-encoding": "gzip" }
    ]
  ])(
    "fails a 200 answer with %s as reader-failed and reports it",
    async (_label, headers) => {
      const reportPageReaderFailure = vi.fn()
      const server = await startVmoServer((_request, response) => {
        response.writeHead(200, headers)
        response.end(JSON.stringify({ html: PAGE_HTML, isTruncated: false }))
      })

      const result = await getRenderedPage(
        PAGE_URL,
        new AbortController().signal,
        buildVmoReadDependencies(server.origin, { reportPageReaderFailure })
      )

      expect(result).toEqual(buildFailure("reader-failed"))
      expect(reportPageReaderFailure).toHaveBeenCalledTimes(1)
    }
  )

  it.each([
    ["text that is not JSON", "secret page text {"],
    ["bytes that are not UTF-8", Uint8Array.from([0x22, 0xff, 0x22])],
    ["HTML that is not text", JSON.stringify({ html: 1, isTruncated: false })],
    ["no truncation flag", JSON.stringify({ html: "secret page text" })],
    [
      "a key vmo does not send",
      JSON.stringify({ html: PAGE_HTML, isTruncated: false, exitCode: 0 })
    ],
    ["a list", "[]"],
    ["null", "null"]
  ])(
    "fails a 200 answer with %s as reader-failed and reports it without its body",
    async (_label, body) => {
      const reportPageReaderFailure = vi.fn()
      const server = await startVmoServer(
        answerWithBody(200, VMO_JSON_CONTENT_TYPE, body)
      )

      const result = await getRenderedPage(
        PAGE_URL,
        new AbortController().signal,
        buildVmoReadDependencies(server.origin, { reportPageReaderFailure })
      )

      expect(result).toEqual(buildFailure("reader-failed"))
      expect(reportPageReaderFailure).toHaveBeenCalledTimes(1)
      const reported: unknown = reportPageReaderFailure.mock.calls[0]?.[0]
      expect(reported).toBeInstanceOf(Error)
      expect((reported as Error).message).not.toContain("secret")
    }
  )

  it("fails as reader-unreachable and reports the refusal when vmo is not listening", async () => {
    const reportPageReaderFailure = vi.fn()

    const result = await getRenderedPage(
      PAGE_URL,
      new AbortController().signal,
      buildVmoReadDependencies(await findClosedVmoOrigin(), {
        reportPageReaderFailure
      })
    )

    expect(result).toEqual(buildFailure("reader-unreachable"))
    expect(reportPageReaderFailure).toHaveBeenCalledTimes(1)
    expect(reportPageReaderFailure.mock.calls[0]?.[0]).toMatchObject({
      code: "ECONNREFUSED"
    })
  })

  it("fails as reader-unreachable when vmo closes the connection without answering", async () => {
    const reportPageReaderFailure = vi.fn()
    const server = await startVmoServer((request) => request.socket.destroy())

    const result = await getRenderedPage(
      PAGE_URL,
      new AbortController().signal,
      buildVmoReadDependencies(server.origin, { reportPageReaderFailure })
    )

    expect(result).toEqual(buildFailure("reader-unreachable"))
    expect(reportPageReaderFailure).toHaveBeenCalledTimes(1)
  })

  it("fails as reader-unreachable when the connection breaks while vmo answers", async () => {
    const server = await startVmoServer((request, response) => {
      response.writeHead(200, { "content-type": VMO_JSON_CONTENT_TYPE })
      response.write('{"html":"<p>Moths', () => request.socket.destroy())
    })

    const result = await getRenderedPage(
      PAGE_URL,
      new AbortController().signal,
      buildVmoReadDependencies(server.origin)
    )

    expect(result).toEqual(buildFailure("reader-unreachable"))
  })

  it("fails as reader-timed-out and reports it when vmo does not answer in time", async () => {
    const reportPageReaderFailure = vi.fn()
    const server = await startVmoServer(() => {
      // Never answers, so only the time limit ends the read.
    })

    const result = await getRenderedPage(
      PAGE_URL,
      new AbortController().signal,
      buildVmoReadDependencies(server.origin, {
        readTimeoutMs: 100,
        reportPageReaderFailure
      })
    )

    expect(result).toEqual(buildFailure("reader-timed-out"))
    expect(reportPageReaderFailure).toHaveBeenCalledTimes(1)
    expect(reportPageReaderFailure.mock.calls[0]?.[0]).toMatchObject({
      name: "TimeoutError"
    })
  })

  it("fails as reader-timed-out and reports it when vmo's answer stops in the middle", async () => {
    const reportPageReaderFailure = vi.fn()
    const server = await startVmoServer((_request, response) => {
      response.writeHead(200, { "content-type": VMO_JSON_CONTENT_TYPE })
      response.write('{"html":"<p>Moths')
    })

    const result = await getRenderedPage(
      PAGE_URL,
      new AbortController().signal,
      buildVmoReadDependencies(server.origin, {
        readTimeoutMs: 100,
        reportPageReaderFailure
      })
    )

    expect(result).toEqual(buildFailure("reader-timed-out"))
    expect(reportPageReaderFailure).toHaveBeenCalledTimes(1)
    expect(reportPageReaderFailure.mock.calls[0]?.[0]).toMatchObject({
      name: "TimeoutError"
    })
  })

  it("fails as reader-timed-out without asking vmo when the host lookup takes too long", async () => {
    const server = await startVmoServer(answerWithPage(PAGE_HTML))

    const result = await getRenderedPage(
      PAGE_URL,
      new AbortController().signal,
      buildVmoReadDependencies(server.origin, {
        lookupHostAddresses: neverAnswerLookup,
        readTimeoutMs: 100
      })
    )

    expect(result).toEqual(buildFailure("reader-timed-out"))
    expect(server.receivedRequests).toHaveLength(0)
  })

  it.each([
    ["https://private.test/moths", "blocked-address"],
    ["https://missing.test/moths", "unresolvable-host"]
  ] as const)(
    "fails %s as %s without asking vmo, unreported",
    async (urlText, kind) => {
      const reportPageReaderFailure = vi.fn()
      const server = await startVmoServer(answerWithPage(PAGE_HTML))

      const result = await getRenderedPage(
        buildTestPageUrl(urlText),
        new AbortController().signal,
        buildVmoReadDependencies(server.origin, { reportPageReaderFailure })
      )

      expect(result).toEqual(buildFailure(kind))
      expect(server.receivedRequests).toHaveLength(0)
      expect(reportPageReaderFailure).not.toHaveBeenCalled()
    }
  )

  it("rejects with a lookup failure that has no system code, without asking vmo", async () => {
    const defect = new Error("resolver defect")
    const server = await startVmoServer(answerWithPage(PAGE_HTML))

    const read = getRenderedPage(
      PAGE_URL,
      new AbortController().signal,
      buildVmoReadDependencies(server.origin, {
        lookupHostAddresses: () => Promise.reject(defect)
      })
    )

    await expect(read).rejects.toBe(defect)
    expect(server.receivedRequests).toHaveLength(0)
  })

  it.each([
    ["is not a URL", "not a url", "ERR_INVALID_URL"],
    ["is not an http URL", "ftp://127.0.0.1:8080", "ERR_INVALID_PROTOCOL"]
  ])(
    "rejects, as a defect and unreported, a vmo origin that %s",
    async (_label, vmoOrigin, code) => {
      const reportPageReaderFailure = vi.fn()

      const read = getRenderedPage(
        PAGE_URL,
        new AbortController().signal,
        buildVmoReadDependencies(vmoOrigin, { reportPageReaderFailure })
      )

      await expect(read).rejects.toMatchObject({ code })
      expect(reportPageReaderFailure).not.toHaveBeenCalled()
    }
  )

  it.each([
    "https://93.184.216.34/moths",
    "https://[2606:2800:220:1::1]/moths"
  ])("asks vmo for %s without looking its host up", async (urlText) => {
    const server = await startVmoServer(answerWithPage(PAGE_HTML))

    const result = await getRenderedPage(
      buildTestPageUrl(urlText),
      new AbortController().signal,
      buildVmoReadDependencies(server.origin, {
        lookupHostAddresses: refuseLookup
      })
    )

    expect(result).toMatchObject({ status: "rendered" })
    expect(server.receivedRequests).toHaveLength(1)
  })

  it("rejects with the abort reason when stopped while vmo reads", async () => {
    const abortController = new AbortController()
    const stopReason = new Error("stopped")
    const reportPageReaderFailure = vi.fn()
    const server = await startVmoServer(() => abortController.abort(stopReason))

    const read = getRenderedPage(
      PAGE_URL,
      abortController.signal,
      buildVmoReadDependencies(server.origin, { reportPageReaderFailure })
    )

    await expect(read).rejects.toBe(stopReason)
    expect(reportPageReaderFailure).not.toHaveBeenCalled()
  })

  it("rejects with the abort reason without asking vmo when stopped during the host lookup", async () => {
    const abortController = new AbortController()
    const stopReason = new Error("stopped")
    const server = await startVmoServer(answerWithPage(PAGE_HTML))

    const read = getRenderedPage(
      PAGE_URL,
      abortController.signal,
      buildVmoReadDependencies(server.origin, {
        lookupHostAddresses: (hostname) => {
          abortController.abort(stopReason)
          return listTestHostAddresses(hostname)
        }
      })
    )

    await expect(read).rejects.toBe(stopReason)
    expect(server.receivedRequests).toHaveLength(0)
  })

  it("rejects with the abort reason and starts nothing when already stopped", async () => {
    const abortController = new AbortController()
    const stopReason = new Error("stopped")
    abortController.abort(stopReason)
    const lookupHostAddresses = vi.fn(listTestHostAddresses)
    const server = await startVmoServer(answerWithPage(PAGE_HTML))

    const read = getRenderedPage(
      PAGE_URL,
      abortController.signal,
      buildVmoReadDependencies(server.origin, { lookupHostAddresses })
    )

    await expect(read).rejects.toBe(stopReason)
    expect(lookupHostAddresses).not.toHaveBeenCalled()
    expect(server.receivedRequests).toHaveLength(0)
  })
})
