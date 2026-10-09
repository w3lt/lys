import { createLlmServiceBusyProblem } from "@lys/protocol"
import { describe, expect, it } from "vitest"
import {
  connectLlmRuntime,
  getBackendHealth,
  getLlmRuntimeConnectionStatus
} from "@/lib/apis/http/runtime"
import {
  buildJsonResponse,
  startBackendEventStream,
  startBackendFake
} from "../../../support/backendFake"

/** Backend origin the cases pass; it differs from the production default. */
const BACKEND_URL = "http://backend.test:4100"

/** Health timeout the contract promises, in milliseconds. */
const HEALTH_CHECK_TIMEOUT_MS = 1000

describe("getBackendHealth", () => {
  it("reports answering after a successful health response", async () => {
    const backend = startBackendFake({
      "GET /api/v1/heath": () => buildJsonResponse(200, { status: "ok" })
    })

    await expect(getBackendHealth(BACKEND_URL)).resolves.toBe("answering")
    expect(backend.requests).toMatchObject([
      { url: `${BACKEND_URL}/api/v1/heath`, cache: "no-store" }
    ])
  })

  it("discards a health body without waiting for it to end", async () => {
    const stream = startBackendEventStream()
    startBackendFake({ "GET /api/v1/heath": () => stream.response })

    await expect(getBackendHealth(BACKEND_URL)).resolves.toBe("answering")
    expect(stream.isCancelled()).toBe(true)
  })

  it("reports not answering for an unsuccessful status", async () => {
    startBackendFake({
      "GET /api/v1/heath": () => new Response(null, { status: 503 })
    })

    await expect(getBackendHealth(BACKEND_URL)).resolves.toBe("not-answering")
  })

  it("reports not answering when the backend cannot be reached", async () => {
    startBackendFake({
      "GET /api/v1/heath": () => Promise.reject(new TypeError("fetch failed"))
    })

    await expect(getBackendHealth(BACKEND_URL)).resolves.toBe("not-answering")
  })

  it("reports not answering once a pending check reaches its one-second timeout", async () => {
    const backend = startBackendFake({
      "GET /api/v1/heath": () => new Promise<Response>(() => {})
    })
    const startedAt = performance.now()

    await expect(getBackendHealth(BACKEND_URL)).resolves.toBe("not-answering")

    // Fake timers do not drive AbortSignal.timeout, so this case waits for the
    // real timeout; only the lower bound is asserted, as an upper bound would
    // depend on machine speed.
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(
      HEALTH_CHECK_TIMEOUT_MS - 50
    )
    expect(backend.requests[0]?.signal?.reason).toMatchObject({
      name: "TimeoutError"
    })
  })
})

describe.each([
  {
    operation: "getLlmRuntimeConnectionStatus",
    readStatus: getLlmRuntimeConnectionStatus,
    route: "GET /api/v1/llm/runtime"
  },
  {
    operation: "connectLlmRuntime",
    readStatus: connectLlmRuntime,
    route: "POST /api/v1/llm/runtime/connect"
  }
])("$operation", ({ readStatus, route }) => {
  it.each(["connecting", "connected", "unreachable"] as const)(
    "returns the %s status the backend reports",
    async (status) => {
      const backend = startBackendFake({
        [route]: () => buildJsonResponse(200, { status })
      })
      const signal = new AbortController().signal

      await expect(
        readStatus({ backendUrl: BACKEND_URL, signal })
      ).resolves.toBe(status)
      expect(backend.requests).toHaveLength(1)
      expect(backend.requests[0]?.cache).toBe("no-store")
      expect(backend.requests[0]?.signal).toBe(signal)
      expect(backend.requests[0]?.headers.get("Accept")).toBe(
        "application/json"
      )
    }
  )

  it("rejects an unsuccessful status without exposing its body", async () => {
    startBackendFake({
      [route]: () => buildJsonResponse(503, createLlmServiceBusyProblem())
    })

    const status = readStatus({
      backendUrl: BACKEND_URL,
      signal: new AbortController().signal
    })

    await expect(status).rejects.toThrow("HTTP 503")
    await expect(status).rejects.not.toThrow("queue is full")
  })

  it("rejects an invalid status payload and keeps the decoding failure as its cause", async () => {
    startBackendFake({
      [route]: () => buildJsonResponse(200, { status: "secret-raw-value" })
    })

    const status = readStatus({
      backendUrl: BACKEND_URL,
      signal: new AbortController().signal
    })

    await expect(status).rejects.toMatchObject({
      cause: expect.objectContaining({ name: "ZodError" })
    })
    await expect(status).rejects.not.toThrow("secret-raw-value")
  })

  it("rejects a body that is not JSON", async () => {
    startBackendFake({
      [route]: () =>
        new Response("<html>", {
          status: 200,
          headers: { "Content-Type": "text/html" }
        })
    })

    await expect(
      readStatus({
        backendUrl: BACKEND_URL,
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({ cause: expect.any(SyntaxError) })
  })

  it("rejects with the abort reason when the caller cancels", async () => {
    startBackendFake({ [route]: () => new Promise<Response>(() => {}) })
    const controller = new AbortController()

    const status = readStatus({
      backendUrl: BACKEND_URL,
      signal: controller.signal
    })
    controller.abort()

    await expect(status).rejects.toMatchObject({ name: "AbortError" })
  })
})
