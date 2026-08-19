import { loadSettings } from "@/lib/apis/tauri/settings"
import { initialSettingsState, type LysSettings } from "./settings"
import { create } from "zustand"
import { BACKEND_HOST, BACKEND_PORT } from "@lys/protocol"
import { getBackendStatus, startBackend, stopBackend } from "../apis"

/** Top-level view selected by the application store. */
export type AppView = "chat" | "settings"
/** Lifecycle states mirrored from Tauri's backend process status. */
export type BackendServerStatus =
  "running" | "starting" | "stopping" | "stopped"

/** Store-owned backend lifecycle timestamps and current status. */
export type BackendServerInfo = {
  /** Current process lifecycle state. */
  status: BackendServerStatus
  /** Renderer timestamp assigned after a start response and also unconditionally during initialization. */
  startedAt?: Date
  /** Renderer timestamp assigned after a stop response reports that the process is stopped. */
  stoppedAt?: Date
}

/** Mutable application values owned by the Zustand store. */
type LysState = {
  /** Active top-level view. */
  activeView: AppView
  /** Settings loaded from or destined for Tauri persistence. */
  settings: LysSettings
  /** Local HTTP base URL used by desktop transport consumers. */
  backendUrl: string
  /** True while initialization is pending; a rejected initialization leaves it true and the shell blank. */
  initializing: boolean
  /** Backend process lifecycle tracked by the store. */
  backendServerInfo: BackendServerInfo
  /** Whether the selected model is known to be loaded; currently not updated by actions. */
  selectedModelLoaded: boolean
}

/** Actions exposed by the application store. */
type LysActions = {
  /**
   * Selects the top-level view synchronously.
   *
   * @param view - View to make active.
   */
  setActiveView: (view: AppView) => void
  /**
   * Replaces store-owned settings without persisting them.
   *
   * @param settings - Complete settings value to keep in memory.
   */
  setSettings: (settings: LysSettings) => void
  /**
   * Loads settings, optionally starts the backend, and marks initialization complete on success.
   *
   * @returns A promise resolving after store initialization is committed.
   * @throws The settings or backend Tauri rejection; state remains initializing when it rejects.
   */
  initialize: () => Promise<void>
  /**
   * Starts the backend when it is not already running; a non-running command result leaves the start transition pending.
   *
   * @returns A promise resolving after the status command and any start command settle.
   * @throws The Tauri status or start rejection.
   */
  startBackend: () => Promise<void>
  /**
   * Stops the backend when it is currently running; a still-running result leaves the stop transition pending.
   *
   * @returns A promise resolving after the status command and any stop command settle.
   * @throws The Tauri status or stop rejection.
   */
  stopBackend: () => Promise<void>
  /**
   * Returns elapsed backend uptime in milliseconds, or zero when unavailable.
   *
   * @returns The non-negative difference from `startedAt` to `Date.now()` for
   * non-stopped states, or to `stoppedAt` for a stopped state; missing either
   * required timestamp returns zero.
   */
  getBackendUptimeMs: () => number
}

/** Complete Zustand store contract combining state and actions. */
type LysStore = LysState & LysActions

/** Initial renderer-side store state before Tauri initialization. */
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

/**
 * Zustand hook and store for application view, settings, and backend lifecycle state.
 *
 * @remarks Initialization and process actions are application-owned asynchronous
 * transitions. Tauri errors propagate from the returned promises; settings are
 * not saved by `setSettings` unless a caller invokes the save adapter separately.
 */
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
