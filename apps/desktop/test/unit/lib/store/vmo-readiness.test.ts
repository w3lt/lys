import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getVmoReadiness } from "@/lib/store/vmo-readiness"
import { startNativeHostFake } from "../../support/nativeHostFake"
import { createSettlementReader } from "../../support/settlement"

/** Status of the owned vmo while it runs. */
const RUNNING_VMO = Object.freeze({ status: "running", pid: 4343 })

/**
 * Starts a host whose vmo runs and answers its health route only from the
 * given check on.
 *
 * @param firstReadyCheck - One-based check that first answers ready.
 * @returns The host observation handle.
 */
function startHostReadyFrom(firstReadyCheck: number) {
  let checks = 0
  return startNativeHostFake({
    get_vmo_status: () => RUNNING_VMO,
    get_vmo_health: () => {
      checks += 1
      return checks >= firstReadyCheck ? "ready" : "not-ready"
    }
  })
}

/**
 * Lists the command names a host received, in order.
 *
 * @param host - Host observation handle.
 * @returns The command names.
 */
function listCommandNames(host: ReturnType<typeof startNativeHostFake>) {
  return host.commands.map((invoked) => invoked.command)
}

describe("getVmoReadiness", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("checks the process before the health route and reports ready once vmo answers", async () => {
    const host = startHostReadyFrom(1)

    await expect(getVmoReadiness()).resolves.toBe("ready")
    expect(listCommandNames(host)).toEqual(["get_vmo_status", "get_vmo_health"])
  })

  it("checks again every second until vmo answers", async () => {
    const host = startHostReadyFrom(3)

    const getSettlement = createSettlementReader(getVmoReadiness())
    await vi.advanceTimersByTimeAsync(999)
    const checksBeforeInterval = listCommandNames(host).filter(
      (command) => command === "get_vmo_health"
    ).length
    await vi.advanceTimersByTimeAsync(1_001)

    expect(checksBeforeInterval).toBe(1)
    expect(
      listCommandNames(host).filter((command) => command === "get_vmo_health")
    ).toHaveLength(3)
    expect(getSettlement()).toBe("fulfilled")
  })

  it("reports exited without asking the health route once the owned process is gone", async () => {
    const host = startNativeHostFake({
      get_vmo_status: () => ({ status: "stopped" })
    })

    await expect(getVmoReadiness()).resolves.toBe("exited")
    expect(listCommandNames(host)).toEqual(["get_vmo_status"])
  })

  it("reports unresponsive once ten minutes pass without an answer from a live process", async () => {
    startHostReadyFrom(Number.POSITIVE_INFINITY)

    const readiness = getVmoReadiness()
    const getSettlement = createSettlementReader(readiness)
    await vi.advanceTimersByTimeAsync(599_999)
    const beforeDeadline = getSettlement()
    await vi.advanceTimersByTimeAsync(1)

    expect(beforeDeadline).toBe("pending")
    await expect(readiness).resolves.toBe("unresponsive")
  })

  it("rejects with the host's rejection when the process status cannot be read", async () => {
    startNativeHostFake({
      get_vmo_status: () => Promise.reject("Failed to inspect vmo process")
    })

    await expect(getVmoReadiness()).rejects.toBe(
      "Failed to inspect vmo process"
    )
  })
})
