import { useEffect, useState } from "react"
import { type BackendServerStatus, useLysStore } from "../store"

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
