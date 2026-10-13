import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import {
  MAXIMUM_TAVILY_RESPONSE_BYTES,
  sendTavilyRequest,
  type TavilyRequest,
  type TavilyRequestDependencies,
  type TavilyRequestResult
} from "../../../../../../src/modules/tool/builtIn/web/tavilyRequest"
import { isBlockedAddress } from "../../../../../../src/modules/tool/builtIn/web/webAddresses"
import {
  answerWithJson,
  startTavilyServer,
  startTlsTavilyServer,
  TEST_TAVILY_API_KEY
} from "../../../../support/tavilyServer"

/** A search request with a small JSON body. */
const SEARCH_REQUEST: TavilyRequest = Object.freeze({
  method: "POST",
  path: "/search",
  apiKey: TEST_TAVILY_API_KEY,
  body: '{"query":"moths"}'
})

/** A usage request, which has no body. */
const USAGE_REQUEST: TavilyRequest = Object.freeze({
  method: "GET",
  path: "/usage",
  apiKey: TEST_TAVILY_API_KEY
})

/**
 * Sends a request that nobody stops.
 *
 * @param request - Request to send.
 * @param dependencies - Where it goes and its limits.
 * @returns The result.
 */
function sendUnstoppedRequest(
  request: TavilyRequest,
  dependencies: TavilyRequestDependencies
): Promise<TavilyRequestResult> {
  return sendTavilyRequest(request, new AbortController().signal, dependencies)
}

/**
 * Finds a loopback port nothing listens on.
 *
 * @returns A port that was free a moment ago.
 */
async function findClosedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

describe("sendTavilyRequest", () => {
  it("posts the body with the key and Lys's headers", async () => {
    const server = await startTavilyServer(answerWithJson({ results: [] }))

    await sendUnstoppedRequest(SEARCH_REQUEST, server.dependencies)

    const [received] = server.receivedRequests
    expect(received).toMatchObject({
      method: "POST",
      path: "/search",
      body: '{"query":"moths"}'
    })
    expect(received?.headers).toMatchObject({
      authorization: `Bearer ${TEST_TAVILY_API_KEY}`,
      accept: "application/json",
      "accept-encoding": "identity",
      "content-type": "application/json",
      "user-agent":
        "Mozilla/5.0 (compatible; Lys; +https://github.com/w3lt/lys)"
    })
    expect(received?.headers.cookie).toBeUndefined()
    expect(received?.headers.referer).toBeUndefined()
  })

  it("sends a GET without a body or content type", async () => {
    const server = await startTavilyServer(answerWithJson({ key: {} }))

    await sendUnstoppedRequest(USAGE_REQUEST, server.dependencies)

    const [received] = server.receivedRequests
    expect(received).toMatchObject({ method: "GET", path: "/usage", body: "" })
    expect(received?.headers["content-type"]).toBeUndefined()
  })

  it.each([
    [401, {}, undefined],
    [429, { "retry-after": "12" }, 12],
    [429, { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }, undefined],
    [432, {}, undefined],
    [500, {}, undefined]
  ])(
    "reports HTTP %i with its retry delay",
    async (status, headers, retryAfterSeconds) => {
      const server = await startTavilyServer(
        answerWithJson({ detail: { error: "provider text" } }, status, headers)
      )

      const result = await sendUnstoppedRequest(
        SEARCH_REQUEST,
        server.dependencies
      )

      expect(result).toEqual({
        status: "failed",
        failure: { kind: "http-status", status, retryAfterSeconds }
      })
    }
  )

  it("reports a redirect without following it", async () => {
    let targetRequestCount = 0
    const target = createServer((_request, response) => {
      targetRequestCount += 1
      response.end()
    })
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve))
    const { port } = target.address() as AddressInfo
    const server = await startTavilyServer((_request, response) => {
      response.statusCode = 307
      response.setHeader("location", `http://127.0.0.1:${port}/search`)
      response.end()
    })

    const result = await sendUnstoppedRequest(
      SEARCH_REQUEST,
      server.dependencies
    )

    expect(result).toEqual({
      status: "failed",
      failure: { kind: "redirected" }
    })
    expect(targetRequestCount).toBe(0)
    await new Promise<void>((resolve) => target.close(() => resolve()))
  })

  it.each([
    ["an HTML body", { "content-type": "text/html" }, "{}"],
    [
      "a JSON body in another charset",
      { "content-type": "application/json; charset=iso-8859-1" },
      "{}"
    ],
    ["a compressed body", { "content-encoding": "gzip" }, "{}"],
    ["text that is not JSON", {}, "{ results"]
  ])("reports %s as unreadable", async (_label, headers, body) => {
    const server = await startTavilyServer(answerWithJson(body, 200, headers))

    const result = await sendUnstoppedRequest(
      SEARCH_REQUEST,
      server.dependencies
    )

    expect(result).toEqual({
      status: "failed",
      failure: { kind: "unreadable" }
    })
  })

  it("accepts a JSON body that names its charset as UTF-8", async () => {
    const server = await startTavilyServer(
      answerWithJson({ ok: true }, 200, {
        "content-type": 'application/json; charset="UTF-8"'
      })
    )

    const result = await sendUnstoppedRequest(
      SEARCH_REQUEST,
      server.dependencies
    )

    expect(result).toEqual({ status: "succeeded", body: { ok: true } })
  })

  it("reports bytes that are not UTF-8 as unreadable", async () => {
    const server = await startTavilyServer((_request, response) => {
      response.setHeader("content-type", "application/json")
      response.end(Buffer.from([0x22, 0xff, 0x22]))
    })

    const result = await sendUnstoppedRequest(
      SEARCH_REQUEST,
      server.dependencies
    )

    expect(result).toEqual({
      status: "failed",
      failure: { kind: "unreadable" }
    })
  })

  it("accepts a body of exactly the size limit sent in several chunks", async () => {
    const text = `"${"a".repeat(MAXIMUM_TAVILY_RESPONSE_BYTES - 2)}"`
    const server = await startTavilyServer((_request, response) => {
      response.setHeader("content-type", "application/json")
      response.write(text.slice(0, 1000))
      response.write(text.slice(1000, 600_000))
      response.end(text.slice(600_000))
    })

    const result = await sendUnstoppedRequest(
      SEARCH_REQUEST,
      server.dependencies
    )

    expect(result.status).toBe("succeeded")
  })

  it("refuses a body one byte over the size limit", async () => {
    const text = `"${"a".repeat(MAXIMUM_TAVILY_RESPONSE_BYTES - 1)}"`
    const server = await startTavilyServer(answerWithJson(text))

    const result = await sendUnstoppedRequest(
      SEARCH_REQUEST,
      server.dependencies
    )

    expect(result).toEqual({
      status: "failed",
      failure: { kind: "too-large" }
    })
  })

  it("reports a request that takes longer than the time limit", async () => {
    const server = await startTavilyServer(() => {
      // Never answers, so only the time limit ends the request.
    })

    const result = await sendUnstoppedRequest(SEARCH_REQUEST, {
      ...server.dependencies,
      requestTimeoutMs: 50
    })

    expect(result).toEqual({
      status: "failed",
      failure: { kind: "timed-out" }
    })
  })

  it("rejects with the abort reason and sends nothing when already stopped", async () => {
    const server = await startTavilyServer(answerWithJson({}))
    const abortController = new AbortController()
    const stopReason = new Error("stopped")
    abortController.abort(stopReason)

    await expect(
      sendTavilyRequest(
        SEARCH_REQUEST,
        abortController.signal,
        server.dependencies
      )
    ).rejects.toBe(stopReason)
    expect(server.receivedRequests).toHaveLength(0)
  })

  it("rejects with the abort reason when stopped while Tavily answers", async () => {
    const abortController = new AbortController()
    const stopReason = new Error("stopped")
    const server = await startTavilyServer((_request, response) => {
      response.setHeader("content-type", "application/json")
      response.write('{"results": [')
      abortController.abort(stopReason)
    })

    await expect(
      sendTavilyRequest(
        SEARCH_REQUEST,
        abortController.signal,
        server.dependencies
      )
    ).rejects.toBe(stopReason)
  })

  it("refuses an address on this machine before connecting", async () => {
    const server = await startTavilyServer(answerWithJson({}))

    const result = await sendUnstoppedRequest(SEARCH_REQUEST, {
      ...server.dependencies,
      isBlockedAddress
    })

    expect(result).toEqual({
      status: "failed",
      failure: { kind: "blocked-address" }
    })
    expect(server.receivedRequests).toHaveLength(0)
  })

  it("reports a host name without an address", async () => {
    const server = await startTavilyServer(answerWithJson({}))
    const notFound = Object.assign(new Error("not found"), {
      code: "ENOTFOUND"
    })

    const result = await sendUnstoppedRequest(SEARCH_REQUEST, {
      ...server.dependencies,
      lookupHostAddresses: () => Promise.reject(notFound)
    })

    expect(result).toEqual({
      status: "failed",
      failure: { kind: "unresolvable-host" }
    })
  })

  it("reports a refused connection with its system code", async () => {
    const port = await findClosedPort()
    const server = await startTavilyServer(answerWithJson({}))

    const result = await sendUnstoppedRequest(SEARCH_REQUEST, {
      ...server.dependencies,
      origin: `http://tavily.test:${port}`
    })

    expect(result).toEqual({
      status: "failed",
      failure: { kind: "unreachable", code: "ECONNREFUSED" }
    })
  })

  it("refuses an untrusted certificate even when the environment turns verification off", async () => {
    vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0")
    onTestFinished(() => {
      vi.unstubAllEnvs()
    })
    const server = await startTlsTavilyServer(answerWithJson({ results: [] }))

    const result = await sendUnstoppedRequest(
      SEARCH_REQUEST,
      server.dependencies
    )

    expect(result).toEqual({
      status: "failed",
      failure: { kind: "unreachable", code: "DEPTH_ZERO_SELF_SIGNED_CERT" }
    })
    expect(server.receivedRequests).toHaveLength(0)
  })

  it("refuses a server that offers nothing newer than TLS 1.1", async () => {
    const server = await startTlsTavilyServer(answerWithJson({ results: [] }), {
      minVersion: "TLSv1",
      maxVersion: "TLSv1.1",
      ciphers: "DEFAULT@SECLEVEL=0"
    })

    const result = await sendUnstoppedRequest(
      SEARCH_REQUEST,
      server.dependencies
    )

    expect(result).toMatchObject({
      status: "failed",
      failure: { kind: "unreachable" }
    })
    expect(server.receivedRequests).toHaveLength(0)
  })

  it("rejects with a failure it does not recognize", async () => {
    const server = await startTavilyServer(answerWithJson({}))
    const defect = new Error("resolver defect")

    await expect(
      sendUnstoppedRequest(SEARCH_REQUEST, {
        ...server.dependencies,
        lookupHostAddresses: () => Promise.reject(defect)
      })
    ).rejects.toBe(defect)
  })
})
