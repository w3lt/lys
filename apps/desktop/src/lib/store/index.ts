import { loadSettings } from "@/lib/apis/tauri/settings"
import { initialSettingsState, type LysSettings } from "./settings"
import { create } from "zustand"
import { BACKEND_HOST, BACKEND_PORT } from "@lys/protocol"

export type AppView = "chat" | "settings"

type LysState = {
  activeView: AppView
  settings: LysSettings
  backendUrl: string
  initializing: boolean
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
  initializing: true
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
    set({ settings, initializing: false })
  }
}))
