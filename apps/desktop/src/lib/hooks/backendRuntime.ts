import { useEffect, useState } from "react"

import { type BackendServerStatus, useLysStore } from "../store"

/** How often the backend uptime readout is recomputed, in milliseconds. */
const UPTIME_TICK_MS = 1000

/**
 * Tracks the running backend's uptime as a ticking value.
 *
 * @returns Elapsed backend process time in milliseconds, refreshed each second.
 * @remarks The interval is owned by this hook and cleared on unmount. It runs
 * regardless of backend status: a stopped backend reports a value the store
 * already froze at the recorded stop time, so the tick settles on that value
 * and stops causing renders on its own.
 */
export function useBackendUptimeMs(): number {
  const getBackendUptimeMs = useLysStore((state) => state.getBackendUptimeMs)
  const [uptimeMs, setUptimeMs] = useState(getBackendUptimeMs)

  useEffect(() => {
    const intervalId = setInterval(() => {
      setUptimeMs(getBackendUptimeMs())
    }, UPTIME_TICK_MS)

    return () => {
      clearInterval(intervalId)
    }
  }, [getBackendUptimeMs])

  return uptimeMs
}

/**
 * Converts a backend lifecycle status to its visible settings label.
 *
 * @param status - Store-owned backend lifecycle state.
 * @returns The user-facing label for the status.
 */
export function backendStatusLabel(status: BackendServerStatus): string {
  switch (status) {
    case "running":
      return "Backend running"
    case "starting":
      return "Backend starting"
    case "stopping":
      return "Backend stopping"
    case "stopped":
      return "Backend stopped"
  }
}

/**
 * Selects the visual status tone for a backend lifecycle state.
 *
 * @param status - Store-owned backend lifecycle state.
 * @returns The tone name consumed by the status indicator's styles.
 */
export function backendStatusTone(
  status: BackendServerStatus
): "active" | "pending" | "idle" {
  switch (status) {
    case "running":
      return "active"
    case "starting":
    case "stopping":
      return "pending"
    case "stopped":
      return "idle"
  }
}

/**
 * Formats non-negative backend uptime as seconds or minutes and seconds.
 *
 * @param elapsedMs - Elapsed process time in milliseconds; negative values are
 * treated as zero.
 * @returns A compact duration label; minutes intentionally do not roll into
 * hours.
 */
export function formatUptime(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}
