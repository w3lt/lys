import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  calculateBackendStatusTone,
  formatBackendStatusLabel,
  formatUptime
} from "@/lib/hooks/backendRuntime"

describe("formatBackendStatusLabel", () => {
  it.each([
    ["running", "Backend running"],
    ["starting", "Backend starting"],
    ["stopping", "Backend stopping"],
    ["stopped", "Backend stopped"],
    ["unresponsive", "Backend not responding"]
  ] as const)("labels %s as %j", (status, label) => {
    expect(formatBackendStatusLabel(status)).toBe(label)
  })
})

describe("calculateBackendStatusTone", () => {
  it.each([
    ["running", "active"],
    ["starting", "pending"],
    ["stopping", "pending"],
    ["stopped", "idle"],
    ["unresponsive", "danger"]
  ] as const)("shows %s in the %s tone", (status, tone) => {
    expect(calculateBackendStatusTone(status)).toBe(tone)
  })
})

describe("formatUptime", () => {
  it.each([
    [0, "0s"],
    [999, "0s"],
    [59_999, "59s"],
    [60_000, "1m 0s"],
    [61_500, "1m 1s"],
    [3_600_000, "60m 0s"],
    [-5_000, "0s"]
  ])("formats %d ms as %j", (elapsedMs, label) => {
    expect(formatUptime(elapsedMs)).toBe(label)
  })
})

/** Fake-clock time at which each case renders the hook. */
const RENDERED_AT_MS = Date.UTC(2026, 9, 9, 12, 0, 0)

/**
 * Loads a fresh application store and the hook that reads it, under a fake
 * clock set to {@link RENDERED_AT_MS}.
 *
 * @returns The hook and the store it reads uptime from.
 */
async function loadFreshUptimeHook() {
  vi.useFakeTimers({ now: RENDERED_AT_MS })
  vi.resetModules()
  const { useLysStore } = await import("@/lib/store")
  const { useBackendUptimeMs } = await import("@/lib/hooks/backendRuntime")
  return { useLysStore, useBackendUptimeMs }
}

/**
 * Advances the fake clock inside a React update scope.
 *
 * @param milliseconds - Time to advance.
 */
function updateFakeClock(milliseconds: number): void {
  act(() => {
    vi.advanceTimersByTime(milliseconds)
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe("useBackendUptimeMs", () => {
  it("reads the uptime when it is first rendered", async () => {
    const { useLysStore, useBackendUptimeMs } = await loadFreshUptimeHook()
    useLysStore.setState({
      backendServerInfo: {
        status: "running",
        startedAt: new Date(RENDERED_AT_MS - 5000)
      }
    })

    const { result } = renderHook(() => useBackendUptimeMs())

    expect(result.current).toBe(5000)
  })

  it("refreshes the running backend's uptime once a second", async () => {
    const { useLysStore, useBackendUptimeMs } = await loadFreshUptimeHook()
    useLysStore.setState({
      backendServerInfo: {
        status: "running",
        startedAt: new Date(RENDERED_AT_MS - 5000)
      }
    })
    const { result } = renderHook(() => useBackendUptimeMs())

    updateFakeClock(999)
    expect(result.current).toBe(5000)

    updateFakeClock(1)
    expect(result.current).toBe(6000)

    updateFakeClock(2500)
    expect(result.current).toBe(8000)
  })

  it("settles on the value frozen when the backend stopped", async () => {
    const { useLysStore, useBackendUptimeMs } = await loadFreshUptimeHook()
    useLysStore.setState({
      backendServerInfo: {
        status: "running",
        startedAt: new Date(RENDERED_AT_MS - 5000)
      }
    })
    const { result } = renderHook(() => useBackendUptimeMs())

    useLysStore.setState({
      backendServerInfo: {
        status: "stopped",
        startedAt: new Date(RENDERED_AT_MS - 5000),
        stoppedAt: new Date(RENDERED_AT_MS + 500)
      }
    })
    updateFakeClock(3000)

    expect(result.current).toBe(5500)
  })

  it("reports zero before the backend ever started", async () => {
    const { useBackendUptimeMs } = await loadFreshUptimeHook()

    const { result } = renderHook(() => useBackendUptimeMs())
    updateFakeClock(2000)

    expect(result.current).toBe(0)
  })

  it("stops ticking when it is removed", async () => {
    const { useBackendUptimeMs } = await loadFreshUptimeHook()
    const { unmount } = renderHook(() => useBackendUptimeMs())
    expect(vi.getTimerCount()).toBe(1)

    unmount()

    expect(vi.getTimerCount()).toBe(0)
  })
})
