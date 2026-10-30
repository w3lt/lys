import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { describe, expect, it, onTestFinished } from "vitest"
import {
  MAXIMUM_PROVIDER_RESPONSE_BYTES,
  requestProviderJson,
  type ProviderJsonRequest
} from "../../../../../src/modules/llm/runtimes/providerHttp"
import {
  answerWith,
  startProviderServer
} from "../../../support/providerServer"

/**
 * Starts a server that answers every request with one raw body.
 *
 * @param body - Bytes or text sent with status 200.
 * @returns The server's base URL; it closes when the test finishes.
 */
async function startRawServer(body: string | Buffer): Promise<string> {
  const server = createServer((_incoming, outgoing) => {
    outgoing.writeHead(200, { "content-type": "application/json" })
    outgoing.end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  onTestFinished(
    async () =>
      await new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  )
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe("ProviderJsonRequest", () => {
  it("accepts a GET without a body and a POST with one, and nothing else", () => {
    const requests: readonly ProviderJsonRequest[] = [
      { url: "http://127.0.0.1", method: "GET", apiKey: undefined },
      { url: "http://127.0.0.1", method: "POST", apiKey: undefined, body: {} },
      // @ts-expect-error -- A GET carries no body.
      { url: "http://127.0.0.1", method: "GET", apiKey: undefined, body: {} },
      // @ts-expect-error -- A POST carries a body.
      { url: "http://127.0.0.1", method: "POST", apiKey: undefined }
    ]

    expect(requests.map(({ method }) => method)).toEqual([
      "GET",
      "POST",
      "GET",
      "POST"
    ])
  })
})

describe("requestProviderJson", () => {
  it("sends a JSON body with the bearer key and parses the answer", async () => {
    const server = await startProviderServer({
      "POST /api/show": answerWith({ shown: true })
    })

    const answer = await requestProviderJson({
      url: `${server.baseUrl}/api/show`,
      method: "POST",
      apiKey: "synthetic-key",
      body: { model: "qwen3:8b" }
    })

    expect(answer).toEqual({ shown: true })
    expect(server.requests).toEqual([
      {
        method: "POST",
        path: "/api/show",
        authorization: "Bearer synthetic-key",
        body: { model: "qwen3:8b" }
      }
    ])
  })

  it("names the status of an answer that is not 2xx, without its body", async () => {
    const server = await startProviderServer({
      "GET /models": answerWith({ error: "secret detail" }, 403)
    })

    const request = requestProviderJson({
      url: `${server.baseUrl}/models`,
      method: "GET",
      apiKey: undefined
    })

    await expect(request).rejects.toThrow(
      /^The provider answered with HTTP 403\.$/
    )
  })

  it("rejects an answer that is not JSON without quoting it", async () => {
    const baseUrl = await startRawServer("<html>secret</html>")

    await expect(
      requestProviderJson({ url: baseUrl, method: "GET", apiKey: undefined })
    ).rejects.toThrow(/^The provider's answer is not JSON\.$/)
  })

  it("rejects an answer longer than the limit", async () => {
    const baseUrl = await startRawServer(
      Buffer.alloc(MAXIMUM_PROVIDER_RESPONSE_BYTES + 1, 0x20)
    )

    await expect(
      requestProviderJson({ url: baseUrl, method: "GET", apiKey: undefined })
    ).rejects.toThrow(
      `The provider's answer is longer than ${MAXIMUM_PROVIDER_RESPONSE_BYTES} bytes.`
    )
  })
})
