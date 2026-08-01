import { loadSettings } from "@/lib/apis/tauri/settings"
import { LysSettings, initialSettingsState } from "./settings"
import { create } from "zustand"
import { BACKEND_HOST, BACKEND_PORT } from "@lys/protocol"
import { getBackendStatus, startBackend } from "../apis"

export type AppView = "chat" | "settings"
export type BackendServerStatus =
  "running" | "starting" | "stopping" | "stopped"

type LysState = {
  activeView: AppView
  settings: LysSettings
  backendUrl: string
  initializing: boolean
  backendServerStatus: BackendServerStatus
  selectedModelLoaded: boolean
}

type LysActions = {
  setActiveView: (view: AppView) => void
  setSettings: (settings: LysSettings) => void
  initialize: () => Promise<void>
}

type LysStore = LysState & LysActions

const initialState: LysState = {
  activeView: "chat",
  settings: initialSettingsState,
  backendUrl: `http://${BACKEND_HOST}:${BACKEND_PORT}`,
  initializing: true,
  backendServerStatus: "stopped",
  selectedModelLoaded: false
}

export const useLysStore = create<LysStore>()((set) => ({
  ...initialState,

  setActiveView: (view) => {
    set({ activeView: view })
  },

  setSettings: (settings) => {
    set({ settings })
  },

  initialize: async () => {
    const settings = await loadSettings()
    if (settings.runtime.autoStartBackend) {
      await startBackend()
    }
    const backendServerStatus: BackendServerStatus = (await getBackendStatus())
      .running
      ? "running"
      : "stopped"
    set({ settings, initializing: false, backendServerStatus })
  }
}))
