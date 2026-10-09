import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getBackendReadiness } from "@/lib/store/backend-readiness"
import { buildJsonResponse, startBackendFake } from "../../support/backendFake"
import { startNativeHostFake } from "../../support/nativeHostFake"
import { createSettlementReader } from "../../support/settlement"

/** Backend origin the cases check; it differs from the production default. */
const BACKEND_URL = "http://backend.test:4100"

/** Route key of the health check. */
const HEALTH_ROUTE = "GET /api/v1/heath"

/**
 * Starts a backend whose health route answers only from the given check on.
 *
 * @param firstAnsweringCheck - One-based check that first answers; checks
 * before it fail with HTTP 503.
 * @returns The backend observation handle.
 */
function startBackendAnsweringFrom(firstAnsweringCheck: number) {
  let checks = 0
  return startBackendFake({
    [HEALTH_ROUTE]: () => {
      checks += 1
      return checks >= firstAnsweringCheck
        ? buildJsonResponse(200, { status: "ok" })
        : new Response(null, { status: 503 })
    }
  })
}

describe("getBackendReadiness", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("reports ready as soon as the health route answers", async () => {
    startBackendAnsweringFrom(1)
    const host = startNativeHostFake({})

    await expect(getBackendReadiness(BACKEND_URL)).resolves.toBe("ready")
    expect(host.commands).toEqual([])
  })

  it("checks again every 250 ms until the health route answers", async () => {
    const backend = startBackendAnsweringFrom(3)
    startNativeHostFake({ get_backend_status: () => ({ running: true }) })

    const readSettlement = createSettlementReader(
      getBackendReadiness(BACKEND_URL)
    )
    await vi.advanceTimersByTimeAsync(249)
    const checksBeforeInterval = backend.requests.length
    await vi.advanceTimersByTimeAsync(251)

    expect(checksBeforeInterval).toBe(1)
    expect(backend.requests).toHaveLength(3)
    expect(readSettlement()).toBe("fulfilled")
  })

  it("reports exited when the process stops before answering", async () => {
    startBackendAnsweringFrom(Number.POSITIVE_INFINITY)
    startNativeHostFake({ get_backend_status: () => ({ running: false }) })

    await expect(getBackendReadiness(BACKEND_URL)).resolves.toBe("exited")
  })

  it("reports unresponsive once 30 seconds pass without an answer from a live process", async () => {
    startBackendAnsweringFrom(Number.POSITIVE_INFINITY)
    startNativeHostFake({ get_backend_status: () => ({ running: true }) })

    const readiness = getBackendReadiness(BACKEND_URL)
    const readSettlement = createSettlementReader(readiness)
    await vi.advanceTimersByTimeAsync(29_999)
    const beforeDeadline = readSettlement()
    await vi.advanceTimersByTimeAsync(1)

    expect(beforeDeadline).toBe("pending")
    await expect(readiness).resolves.toBe("unresponsive")
  })

  it("rejects with the host's rejection when the process status cannot be read", async () => {
    startBackendAnsweringFrom(Number.POSITIVE_INFINITY)
    startNativeHostFake({
      get_backend_status: () => Promise.reject("Failed to inspect the process")
    })

    await expect(getBackendReadiness(BACKEND_URL)).rejects.toBe(
      "Failed to inspect the process"
    )
  })
})
