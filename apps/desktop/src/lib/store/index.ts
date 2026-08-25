import type { SettingsPane } from "@/app/types"
import { loadSettings } from "@/lib/apis/tauri/settings"
import { initialSettingsState, type LysSettings } from "./settings"
import {
  initialModelRuntimeState,
  isModelTransitionInFlight,
  type ModelRuntimeState,
  SIMULATED_MODEL_LOAD_MS,
  SIMULATED_MODEL_UNLOAD_MS
} from "./model-runtime"
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
  /** Residency of the weights, and which weights the current state refers to. */
  modelRuntime: ModelRuntimeState
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
  /**
   * Begins loading the named weights and settles them as resident.
   *
   * @param modelKey - Weights to make resident.
   * @remarks Rejected unless the backend is running and no transition is in
   * flight; loading the already-resident weights is also rejected. Loading
   * different weights while some are resident replaces them. The store owns the
   * transition's timer and cancels it on the next transition, so an observing
   * component must not cancel this work when it unmounts.
   */
  loadModel: (modelKey: string) => void
  /**
   * Begins releasing the named weights and settles them as absent.
   *
   * @param modelKey - Weights to release; must be the resident ones.
   * @remarks Rejected unless exactly those weights are currently resident. The
   * store owns the transition's timer under the same terms as `loadModel`.
   */
  unloadModel: (modelKey: string) => void
  /**
   * Drops residency immediately, cancelling any transition in flight.
   *
   * @remarks Used when the weights cannot have survived, such as after the
   * backend process stops. A cancelled transition never settles, so a load
   * abandoned here cannot later report the weights as resident.
   */
  releaseModelRuntime: () => void
}

/** Complete Zustand store contract combining state and actions. */
type LysStore = LysState & LysActions

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
  },
  modelRuntime: initialModelRuntimeState
}

/**
 * Timer driving the weight transition currently in flight, if any.
 *
 * @remarks Module-scoped because residency is application state: the timer
 * outlives any component observing it, and only a store transition may cancel
 * it. Holding the handle is what proves a superseded transition never settles.
 */
let modelTransitionTimer: ReturnType<typeof setTimeout> | null = null

/** Cancels the weight transition in flight so it can no longer settle. */
function cancelModelTransition(): void {
  if (modelTransitionTimer === null) return

  clearTimeout(modelTransitionTimer)
  modelTransitionTimer = null
}

/**
 * Zustand hook and store for application view, settings, and backend lifecycle state.
 *
 * @remarks Initialization and process actions are application-owned asynchronous
 * transitions. Tauri errors propagate from the returned promises; settings are
 * not saved by `setSettings` unless a caller invokes the save adapter separately.
 *
 * Weight residency is simulated on timers described by `./model-runtime`; no
 * load or unload request reaches the backend yet.
 */
export const useLysStore = create<LysStore>()((set, get) => ({
  ...initialState,

  setActiveView: (view) => {
    set({ activeView: view })
  },

  setSettingsPane: (pane) => {
    set({ settingsPane: pane })
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
      // Weights cannot outlive the process that held them.
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

  loadModel: (modelKey) => {
    const { backendServerInfo, modelRuntime } = get()

    if (backendServerInfo.status !== "running") return
    if (isModelTransitionInFlight(modelRuntime)) return
    if (
      modelRuntime.status === "loaded" &&
      modelRuntime.modelKey === modelKey
    ) {
      return
    }

    cancelModelTransition()
    set({ modelRuntime: { status: "loading", modelKey } })
    modelTransitionTimer = setTimeout(() => {
      modelTransitionTimer = null
      set({ modelRuntime: { status: "loaded", modelKey } })
    }, SIMULATED_MODEL_LOAD_MS)
  },

  unloadModel: (modelKey) => {
    const { modelRuntime } = get()

    if (modelRuntime.status !== "loaded") return
    if (modelRuntime.modelKey !== modelKey) return

    cancelModelTransition()
    set({ modelRuntime: { status: "unloading", modelKey } })
    modelTransitionTimer = setTimeout(() => {
      modelTransitionTimer = null
      set({ modelRuntime: { status: "none" } })
    }, SIMULATED_MODEL_UNLOAD_MS)
  },

  releaseModelRuntime: () => {
    cancelModelTransition()
    set({ modelRuntime: initialModelRuntimeState })
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
