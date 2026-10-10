import { createServer as createNetServer, type AddressInfo } from "node:net"
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import {
  getWebPage,
  MAXIMUM_PAGE_BODY_BYTES,
  MAXIMUM_PAGE_REDIRECTS
} from "../../../../../../src/modules/tool/builtIn/web/pageRequest"
import { isBlockedAddress } from "../../../../../../src/modules/tool/builtIn/web/webAddresses"
import {
  answerWithBody,
  buildTestPageUrl,
  PAGE_SERVER_DEPENDENCIES,
  startPageServer,
  type PageRoute
} from "../../../../support/pageServer"

/**
 * Finds a loopback port nothing listens on.
 *
 * @returns A port that was free a moment ago.
 */
async function findClosedLoopbackPort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/**
 * Builds a route that redirects `/n` to `/n+1` a given number of times
 * before answering.
 *
 * @param redirectCount - Redirects before the page answers, starting at `/0`.
 * @returns The route.
 */
function answerAfterRedirects(redirectCount: number): PageRoute {
  return (request, response) => {
    const hop = Number(request.url?.slice(1))
    if (hop < redirectCount) {
      response.writeHead(302, { location: `/${hop + 1}` }).end()
      return
    }
    answerWithBody("text/plain", "arrived")(request, response)
  }
}

describe("getWebPage", () => {
  it("reads an HTML page and decodes it by the header's charset", async () => {
    const server = await startPageServer(
      answerWithBody(
        "text/html; charset=windows-1252",
        Uint8Array.from([0x3c, 0x70, 0x3e, 0x63, 0x61, 0x66, 0xe9])
      )
    )
    const url = buildTestPageUrl(server.port, "/article")

    const result = await getWebPage(
      url,
      new AbortController().signal,
      PAGE_SERVER_DEPENDENCIES
    )

    expect(result).toEqual({
      status: "succeeded",
      page: { url, mediaType: "text/html", text: "<p>café", isTruncated: false }
    })
  })

  it.each([
    ["application/xhtml+xml", "text/html"],
    ["text/plain; charset=utf-8", "text/plain"],
    ["TEXT/HTML", "text/html"]
  ])("reads a %s body as %s", async (contentType, mediaType) => {
    const server = await startPageServer(answerWithBody(contentType, "hello"))

    const result = await getWebPage(
      buildTestPageUrl(server.port, "/"),
      new AbortController().signal,
      PAGE_SERVER_DEPENDENCIES
    )

    expect(result).toMatchObject({
      status: "succeeded",
      page: { mediaType, text: "hello" }
    })
  })

  it("names Lys and accepts compressed bodies, sending no cookie", async () => {
    const server = await startPageServer(answerWithBody("text/plain", "ok"))

    await getWebPage(
      buildTestPageUrl(server.port, "/"),
      new AbortController().signal,
      PAGE_SERVER_DEPENDENCIES
    )

    expect(server.receivedHeaders[0]).toMatchObject({
      "user-agent":
        "Mozilla/5.0 (compatible; Lys; +https://github.com/w3lt/lys)",
      "accept-encoding": "gzip, deflate, br"
    })
    expect(server.receivedHeaders[0]).not.toHaveProperty("cookie")
  })

  it.each([
    ["gzip", gzipSync("compressed page")],
    ["x-gzip", gzipSync("compressed page")],
    ["deflate", deflateSync("compressed page")],
    ["br", brotliCompressSync("compressed page")]
  ])("decompresses a %s body", async (encoding, body) => {
    const server = await startPageServer(
      answerWithBody("text/plain", body, { "content-encoding": encoding })
    )

    const result = await getWebPage(
      buildTestPageUrl(server.port, "/"),
      new AbortController().signal,
      PAGE_SERVER_DEPENDENCIES
    )

    expect(result).toMatchObject({
      status: "succeeded",
      page: { text: "compressed page" }
    })
  })

  it("reports a compression Lys does not decode", async () => {
    const server = await startPageServer(
      answerWithBody("text/plain", "x", { "content-encoding": "compress" })
    )

    const result = await getWebPage(
      buildTestPageUrl(server.port, "/"),
      new AbortController().signal,
      PAGE_SERVER_DEPENDENCIES
    )

    expect(result).toEqual({
      status: "failed",
      failure: { kind: "unsupported-encoding", encoding: "compress" }
    })
  })

  it("reports a body that cannot be decompressed as a failed transfer", async () => {
    const server = await startPageServer(
      answerWithBody("text/plain", "not gzip at all", {
        "content-encoding": "gzip"
      })
    )

    const result = await getWebPage(
      buildTestPageUrl(server.port, "/"),
      new AbortController().signal,
      PAGE_SERVER_DEPENDENCIES
    )

    expect(result).toEqual({
      status: "failed",
      failure: { kind: "transfer-failed", code: "Z_DATA_ERROR" }
    })
  })

  it("reads a body exactly at the size limit whole", async () => {
    const server = await startPageServer(
      answerWithBody("text/plain", "a".repeat(MAXIMUM_PAGE_BODY_BYTES))
    )

    const result = await getWebPage(
      buildTestPageUrl(server.port, "/"),
      new AbortController().signal,
      PAGE_SERVER_DEPENDENCIES
    )

    expect(result.status === "succeeded" && result.page.isTruncated).toBe(false)
    expect(result.status === "succeeded" && result.page.text.length).toBe(
      MAXIMUM_PAGE_BODY_BYTES
    )
  })

  it("reads only the beginning of a body past the size limit", async () => {
    const server = await startPageServer(
      answerWithBody("text/plain", "a".repeat(MAXIMUM_PAGE_BODY_BYTES + 1))
    )

    const result = await getWebPage(
      buildTestPageUrl(server.port, "/"),
      new AbortController().signal,
      PAGE_SERVER_DEPENDENCIES
    )

    expect(result.status === "succeeded" && result.page.isTruncated).toBe(true)
    expect(result.status === "succeeded" && result.page.text.length).toBe(
      MAXIMUM_PAGE_BODY_BYTES
    )
  })

  it("follows a relative redirect and reports the final URL", async () => {
    const server = await startPageServer((request, response) => {
      if (request.url === "/old") {
        response.writeHead(301, { location: "/new" }).end()
        return
      }
      answerWithBody("text/plain", `at ${request.url}`)(request, response)
    })

    const result = await getWebPage(
      buildTestPageUrl(server.port, "/old"),
      new AbortController().signal,
      PAGE_SERVER_DEPENDENCIES
    )

    expect(result).toMatchObject({
      status: "succeeded",
      page: { url: buildTestPageUrl(server.port, "/new"), text: "at /new" }
    })
  })

  it("follows the maximum number of redirects and refuses one more", async () => {
    const withinLimitServer = await startPageServer(
      answerAfterRedirects(MAXIMUM_PAGE_REDIRECTS)
    )
    const pastLimitServer = await startPageServer(
      answerAfterRedirects(MAXIMUM_PAGE_REDIRECTS + 1)
    )

    const withinLimit = await getWebPage(
      buildTestPageUrl(withinLimitServer.port, "/0"),
      new AbortController().signal,
      PAGE_SERVER_DEPENDENCIES
    )
    const pastLimit = await getWebPage(
      buildTestPageUrl(pastLimitServer.port, "/0"),
      new AbortController().signal,
      PAGE_SERVER_DEPENDENCIES
    )

    expect(withinLimit).toMatchObject({
      status: "succeeded",
      page: { text: "arrived" }
    })
    expect(pastLimit).toEqual({
      status: "failed",
      failure: { kind: "too-many-redirects" }
    })
  })

  it.each([
    ["this machine", "http://localhost:12345/conversations", "local-address"],
    ["a private address", "http://192.168.1.1/admin", "local-address"],
    ["another scheme", "file:///etc/hosts", "unsupported-scheme"],
    [
      "a URL with credentials",
      "http://user:pw@example.com/",
      "has-credentials"
    ],
    ["an unparsable target", "http://[bad", "not-absolute"]
  ])("refuses a redirect to %s", async (_label, location, problem) => {
    const server = await startPageServer((_request, response) => {
      response.writeHead(307, { location }).end()
    })

    const result = await getWebPage(
      buildTestPageUrl(server.port, "/"),
      new AbortController().signal,
      PAGE_SERVER_DEPENDENCIES
    )

    expect(result).toEqual({
      status: "failed",
      failure: { kind: "invalid-redirect", problem }
    })
  })

  it("reports a status other than 2xx", async () => {
    const server = await startPageServer((_request, response) => {
      response.writeHead(404, { "content-type": "text/html" }).end("missing")
    })

    const result = await getWebPage(
      buildTestPageUrl(server.port, "/"),
      new AbortController().signal,
      PAGE_SERVER_DEPENDENCIES
    )

    expect(result).toEqual({
      status: "failed",
      failure: { kind: "http-status", status: 404 }
    })
  })

  it.each([
    ["a PDF", "application/pdf", "application/pdf"],
    ["an image", "image/png", "image/png"],
    ["a body with no content type", undefined, undefined]
  ])("refuses %s", async (_label, contentType, mediaType) => {
    const server = await startPageServer(answerWithBody(contentType, "%PDF"))

    const result = await getWebPage(
      buildTestPageUrl(server.port, "/"),
      new AbortController().signal,
      PAGE_SERVER_DEPENDENCIES
    )

    expect(result).toEqual({
      status: "failed",
      failure: { kind: "unsupported-content-type", mediaType }
    })
  })

  it("refuses a host that resolves to a blocked address before connecting", async () => {
    const server = await startPageServer(answerWithBody("text/plain", "secret"))

    const result = await getWebPage(
      buildTestPageUrl(server.port, "/"),
      new AbortController().signal,
      { ...PAGE_SERVER_DEPENDENCIES, isBlockedAddress }
    )

    expect(result).toEqual({
      status: "failed",
      failure: { kind: "blocked-address" }
    })
    expect(server.receivedHeaders).toHaveLength(0)
  })

  it("refuses a host when any of its addresses is blocked", async () => {
    const server = await startPageServer(answerWithBody("text/plain", "secret"))

    const result = await getWebPage(
      buildTestPageUrl(server.port, "/"),
      new AbortController().signal,
      {
        ...PAGE_SERVER_DEPENDENCIES,
        lookupHostAddresses: async () => [
          { address: "93.184.215.14", family: 4 },
          { address: "10.0.0.5", family: 4 }
        ],
        isBlockedAddress
      }
    )

    expect(result).toEqual({
      status: "failed",
      failure: { kind: "blocked-address" }
    })
    expect(server.receivedHeaders).toHaveLength(0)
  })

  it("refuses a connection whose socket reached a blocked address after the lookup passed", async () => {
    const server = await startPageServer(answerWithBody("text/plain", "secret"))
    const checkedAddresses: string[] = []

    const result = await getWebPage(
      buildTestPageUrl(server.port, "/"),
      new AbortController().signal,
      {
        ...PAGE_SERVER_DEPENDENCIES,
        isBlockedAddress: (address) => checkedAddresses.push(address) > 1
      }
    )

    expect(result).toEqual({
      status: "failed",
      failure: { kind: "blocked-address" }
    })
    expect(checkedAddresses).toEqual(["127.0.0.1", "127.0.0.1"])
    expect(server.receivedHeaders).toHaveLength(0)
  })

  it.each([
    [
      "the lookup fails with a system code",
      () =>
        Promise.reject(
          Object.assign(new Error("no such host"), { code: "ENOTFOUND" })
        )
    ],
    ["the name has no address", () => Promise.resolve([])]
  ])(
    "reports an unresolvable host when %s",
    async (_label, lookupHostAddresses) => {
      const result = await getWebPage(
        buildTestPageUrl(1, "/"),
        new AbortController().signal,
        { ...PAGE_SERVER_DEPENDENCIES, lookupHostAddresses }
      )

      expect(result).toEqual({
        status: "failed",
        failure: { kind: "unresolvable-host" }
      })
    }
  )

  it("rethrows a lookup failure it does not recognize", async () => {
    const lookupFailure = new Error("lookup defect")

    await expect(
      getWebPage(buildTestPageUrl(1, "/"), new AbortController().signal, {
        ...PAGE_SERVER_DEPENDENCIES,
        lookupHostAddresses: () => Promise.reject(lookupFailure)
      })
    ).rejects.toBe(lookupFailure)
  })

  it("reports a refused connection as a failed transfer", async () => {
    const closedPort = await findClosedLoopbackPort()

    const result = await getWebPage(
      buildTestPageUrl(closedPort, "/"),
      new AbortController().signal,
      PAGE_SERVER_DEPENDENCIES
    )

    expect(result).toEqual({
      status: "failed",
      failure: { kind: "transfer-failed", code: "ECONNREFUSED" }
    })
  })

  it("reports a request that takes longer than its time limit", async () => {
    const server = await startPageServer(() => {
      // Never answers, so only the time limit ends the request.
    })

    const result = await getWebPage(
      buildTestPageUrl(server.port, "/"),
      new AbortController().signal,
      { ...PAGE_SERVER_DEPENDENCIES, requestTimeoutMs: 50 }
    )

    expect(result).toEqual({ status: "failed", failure: { kind: "timed-out" } })
  })

  it("rejects with the abort reason when stopped while waiting", async () => {
    const abortController = new AbortController()
    const stopReason = new Error("stopped")
    const server = await startPageServer(() => {
      abortController.abort(stopReason)
    })

    await expect(
      getWebPage(
        buildTestPageUrl(server.port, "/"),
        abortController.signal,
        PAGE_SERVER_DEPENDENCIES
      )
    ).rejects.toBe(stopReason)
  })

  it("rejects without connecting when already stopped", async () => {
    const abortController = new AbortController()
    const stopReason = new Error("stopped before")
    abortController.abort(stopReason)
    const server = await startPageServer(answerWithBody("text/plain", "x"))

    await expect(
      getWebPage(
        buildTestPageUrl(server.port, "/"),
        abortController.signal,
        PAGE_SERVER_DEPENDENCIES
      )
    ).rejects.toBe(stopReason)
    expect(server.receivedHeaders).toHaveLength(0)
  })
})
