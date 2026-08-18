import { loadSettings } from "@/lib/apis/tauri/settings"
import { initialSettingsState, type LysSettings } from "./settings"
import { create } from "zustand"
import { BACKEND_HOST, BACKEND_PORT } from "@lys/protocol"
import { getBackendStatus, startBackend, stopBackend } from "../apis"

export type AppView = "chat" | "settings"
export type BackendServerStatus =
  "running" | "starting" | "stopping" | "stopped"

export type BackendServerInfo = {
  status: BackendServerStatus
  startedAt?: Date
  stoppedAt?: Date
}

type LysState = {
  activeView: AppView
  settings: LysSettings
  backendUrl: string
  initializing: boolean
  backendServerInfo: BackendServerInfo
  selectedModelLoaded: boolean
}

type LysActions = {
  setActiveView: (view: AppView) => void
  setSettings: (settings: LysSettings) => void
  initialize: () => Promise<void>
  startBackend: () => Promise<void>
  stopBackend: () => Promise<void>
  getBackendUptimeMs: () => number
}

type LysStore = LysState & LysActions

const initialState: LysState = {
  activeView: "chat",
  settings: initialSettingsState,
  backendUrl: `http://${BACKEND_HOST}:${BACKEND_PORT}`,
  initializing: true,
  backendServerInfo: {
    status: "stopped",
    startedAt: undefined,
    stoppedAt: undefined
  },
  selectedModelLoaded: false
}

export const useLysStore = create<LysStore>()((set, get) => ({
  ...initialState,

  setActiveView: (view) => {
    set({ activeView: view })
  },

  setSettings: (settings) => {
    set({ settings })
  },

  startBackend: async () => {
    if ((await getBackendStatus()).running) return

    set({
      backendServerInfo: {
        status: "starting",
        startedAt: undefined,
        stoppedAt: undefined
      }
    })
    const processStatus = await startBackend()
    const now = new Date()
    if (processStatus.running) {
      set({
        backendServerInfo: {
          status: "running",
          startedAt: now,
          stoppedAt: undefined
        }
      })
    }
  },

  stopBackend: async () => {
    if (!(await getBackendStatus()).running) return

    set((prev) => ({
      ...prev,
      backendServerInfo: {
        ...prev.backendServerInfo,
        status: "stopping"
      }
    }))
    const processStatus = await stopBackend()
    const now = new Date()
    if (!processStatus.running) {
      set((prev) => ({
        ...prev,
        backendServerInfo: {
          ...prev.backendServerInfo,
          status: "stopped",
          stoppedAt: now
        }
      }))
    }
  },

  getBackendUptimeMs: () => {
    const { status, startedAt, stoppedAt } = get().backendServerInfo

    if (!startedAt) return 0

    const endTime = status === "stopped" ? stoppedAt?.getTime() : Date.now()

    if (endTime === undefined) return 0

    return Math.max(0, endTime - startedAt.getTime())
  },

  initialize: async () => {
    const settings = await loadSettings()
    if (settings.runtime.autoStartBackend) {
      await startBackend()
    }
    const now = new Date()
    const backendServerStatus: BackendServerStatus = (await getBackendStatus())
      .running
      ? "running"
      : "stopped"
    set({
      settings,
      initializing: false,
      backendServerInfo: {
        status: backendServerStatus,
        startedAt: now,
        stoppedAt: undefined
      }
    })
  }
}))
