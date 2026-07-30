import {
  startBackend as startBackendCommand,
  stopBackend as stopBackendCommand
} from "@/lib/apis"
import { invoke } from "@tauri-apps/api/core"
import { useEffect, useState } from "react"

export type RuntimeSettings = {
  autoStartBackend: boolean
  selectedModel?: string
}

export type BackendStatus = "starting" | "stopping" | "running" | "stopped"

const useRuntimeSettings = () => {
  const [settingsBuffer, setSettingsBuffer] = useState<RuntimeSettings>()
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const settings = await invoke<RuntimeSettings>("load_settings")
        setSettingsBuffer(settings)
      } catch {
        // Temporarily ignore, will handle later
      } finally {
        setLoading(false)
      }
    }

    void loadSettings()
  }, [])

  return { settingsBuffer, setSettingsBuffer, loading }
}

export function useRuntimeSettingsContext() {
  const { settingsBuffer, setSettingsBuffer, loading } = useRuntimeSettings()
  const [backendStatus, setBackendStatus] = useState<BackendStatus>("stopped")

  const startBackend = async () => {
    if (backendStatus === "stopped") {
      setBackendStatus("starting")
      try {
        await startBackendCommand()
        setBackendStatus("running")
      } catch {
        setBackendStatus("stopped")
      }
    }
  }

  const stopBackend = async () => {
    if (backendStatus === "running") {
      setBackendStatus("stopping")
      try {
        await stopBackendCommand()
        setBackendStatus("stopped")
      } catch {
        setBackendStatus("running")
      }
    }
  }

  return {
    startBackend,
    stopBackend,
    settingsBuffer,
    setSettingsBuffer,
    loadingSettings: loading,
    backendStatus
  }
}

export function backendStatusLabel(status: BackendStatus) {
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
