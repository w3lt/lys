import type { SettingsPane } from "@/app/types"
import { loadSettings } from "@/lib/apis/tauri/settings"
import { initialSettingsState, type LysSettings } from "./settings"
import { buildModelRuntime } from "./model-runtime"
import { createModelSlice, type ModelSlice } from "./model-actions"
import {
  isGenerationSettingsEqual,
  createGenerationSettingsSlice,
  type GenerationSettingsSlice
} from "./generation-settings"
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
  /** Pane the settings view opens on; retained across visits to settings. */
  settingsPane: SettingsPane
  /** Settings loaded from or destined for Tauri persistence. */
  settings: LysSettings
  /** Local HTTP base URL used by desktop transport consumers. */
  backendUrl: string
  /** True while initialization is pending; a rejected initialization leaves it true and the shell blank. */
  initializing: boolean
  /** Backend process lifecycle tracked by the store. */
  backendServerInfo: BackendServerInfo
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
   * Selects the settings pane the settings view shows.
   *
   * @param pane - Pane to make active; it stays selected until changed again.
   */
  setSettingsPane: (pane: SettingsPane) => void
  /**
   * Replaces store-owned settings and automatically persists generation edits.
   *
   * @param settings - Complete settings value applied in memory immediately.
   * Runtime and model edits remain session-only; generationSave reports persistence.
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
type LysStore = LysState & LysActions & ModelSlice & GenerationSettingsSlice

/** Initial renderer-side store state before Tauri initialization. */
const initialState: LysState = {
  activeView: "chat",
  settingsPane: "runtime",
  settings: initialSettingsState,
  backendUrl: `http://${BACKEND_HOST}:${BACKEND_PORT}`,
  initializing: true,
  backendServerInfo: {
    status: "stopped",
    startedAt: undefined,
    stoppedAt: undefined
  }
}

/**
 * Zustand hook and store for application view, settings, and backend lifecycle state.
 *
 * @remarks Initialization and process actions are application-owned asynchronous
 * transitions. Tauri errors propagate from the returned promises; settings are
 * edited in memory by setSettings. The generation slice owns automatic saves and
 * retains their completion or failure state across pane changes.
 *
 * Model requests are owned by the model slice and use the shared HTTP protocol.
 * Their errors remain observable in model state across settings-view unmounts.
 */
export const useLysStore = create<LysStore>()((set, get) => ({
  ...initialState,
  ...createGenerationSettingsSlice(set, get),
  ...createModelSlice(set, get, () => ({
    backendUrl: get().backendUrl,
    isRunning: get().backendServerInfo.status === "running",
    defaultModel: get().settings.runtime.defaultModel
  })),

  setActiveView: (view) => {
    set({ activeView: view })
  },

  setSettingsPane: (pane) => {
    set({ settingsPane: pane })
  },

  setSettings: (settings) => {
    const { modelInventory, modelRequest } = get()
    const modelRuntime = buildModelRuntime(
      modelInventory,
      modelRequest,
      settings.runtime.defaultModel
    )
    const hasGenerationChanged = !isGenerationSettingsEqual(
      get().settings.generation,
      settings.generation
    )
    const generationSave =
      hasGenerationChanged && get().generationSave.status !== "saving"
        ? { status: "idle" as const }
        : get().generationSave
    set({ settings, modelRuntime, generationSave })
    if (hasGenerationChanged) void get().saveGenerationSettings()
  },

  startBackend: async () => {
    if ((await getBackendStatus()).running) {
      set({ backendServerInfo: { status: "running", startedAt: new Date() } })
      await get().updateModelInventory()
      return
    }

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
    await get().updateModelInventory()
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
    get().releaseModelRuntime()
    const processStatus = await stopBackend()
    const now = new Date()
    if (!processStatus.running) {
      // LM Studio owns weights separately; discard observations until reconnect.
      get().releaseModelRuntime()
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
    await get().updateModelInventory()
  }
}))
