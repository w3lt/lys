import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getVoiceReadiness } from "@/lib/store/voice-readiness"
import { startNativeHostFake } from "../../support/nativeHostFake"
import { createSettlementReader } from "../../support/settlement"

/** Status of the owned voice while it runs. */
const RUNNING_VOICE = Object.freeze({ status: "running", pid: 4343 })

/**
 * Starts a host whose voice runs and answers its health route only from the
 * given check on.
 *
 * @param firstReadyCheck - One-based check that first answers ready.
 * @returns The host observation handle.
 */
function startHostReadyFrom(firstReadyCheck: number) {
  let checks = 0
  return startNativeHostFake({
    get_voice_status: () => RUNNING_VOICE,
    get_voice_health: () => {
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

describe("getVoiceReadiness", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("checks the process before the health route and reports ready once voice answers", async () => {
    const host = startHostReadyFrom(1)

    await expect(getVoiceReadiness()).resolves.toBe("ready")
    expect(listCommandNames(host)).toEqual([
      "get_voice_status",
      "get_voice_health"
    ])
  })

  it("checks again every second until voice answers", async () => {
    const host = startHostReadyFrom(3)

    const getSettlement = createSettlementReader(getVoiceReadiness())
    await vi.advanceTimersByTimeAsync(999)
    const checksBeforeInterval = listCommandNames(host).filter(
      (command) => command === "get_voice_health"
    ).length
    await vi.advanceTimersByTimeAsync(1_001)

    expect(checksBeforeInterval).toBe(1)
    expect(
      listCommandNames(host).filter((command) => command === "get_voice_health")
    ).toHaveLength(3)
    expect(getSettlement()).toBe("fulfilled")
  })

  it("reports exited without asking the health route once the owned process is gone", async () => {
    const host = startNativeHostFake({
      get_voice_status: () => ({ status: "stopped" })
    })

    await expect(getVoiceReadiness()).resolves.toBe("exited")
    expect(listCommandNames(host)).toEqual(["get_voice_status"])
  })

  it("reports unresponsive once twenty minutes pass without an answer from a live process", async () => {
    startHostReadyFrom(Number.POSITIVE_INFINITY)

    const readiness = getVoiceReadiness()
    const getSettlement = createSettlementReader(readiness)
    await vi.advanceTimersByTimeAsync(1_199_999)
    const beforeDeadline = getSettlement()
    await vi.advanceTimersByTimeAsync(1)

    expect(beforeDeadline).toBe("pending")
    await expect(readiness).resolves.toBe("unresponsive")
  })

  it("rejects with the host's rejection when the process status cannot be read", async () => {
    startNativeHostFake({
      get_voice_status: () => Promise.reject("Failed to inspect voice process")
    })

    await expect(getVoiceReadiness()).rejects.toBe(
      "Failed to inspect voice process"
    )
  })
})
