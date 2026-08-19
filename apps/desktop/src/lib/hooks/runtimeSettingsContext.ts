import { useEffect, useState } from "react"
import { type BackendServerStatus, useLysStore } from "../store"

/**
 * Collects runtime settings controls and a live backend uptime value for the settings pane.
 *
 * @returns Store actions, a local editable settings buffer, backend status, and uptime in milliseconds.
 * @remarks The returned buffer is component-owned until a caller commits it. The effect
 * updates uptime every second and currently does not return interval cleanup on unmount;
 * backend command failures propagate through the store actions.
 */
export function useRuntimeSettingsContext() {
  const runtimeSettings = useLysStore((state) => state.settings.runtime)
  const { startBackend, stopBackend, backendServerInfo, getBackendUptimeMs } =
    useLysStore((state) => state)
  const [settingsBuffer, setSettingsBuffer] = useState(runtimeSettings)
  const [uptimeMs, setUptimeMs] = useState(() => {
    return getBackendUptimeMs()
  })

  useEffect(() => {
    setInterval(() => {
      setUptimeMs(getBackendUptimeMs())
    }, 1000)
  }, [getBackendUptimeMs])

  return {
    startBackend,
    stopBackend,
    settingsBuffer,
    setSettingsBuffer,
    backendServerInfo,
    uptimeMs
  }
}

/**
 * Converts a backend lifecycle status to its visible settings label.
 *
 * @param status - Store-owned backend lifecycle state.
 * @returns The user-facing label for the status.
 */
export function backendStatusLabel(status: BackendServerStatus) {
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
