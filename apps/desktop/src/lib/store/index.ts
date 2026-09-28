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
import { getBackendReadiness, type BackendReadiness } from "./backend-readiness"
import {
  createLmStudioStatusSlice,
  type LmStudioStatus,
  type LmStudioStatusSlice
} from "./lm-studio-status"
import { create } from "zustand"
import { BACKEND_HOST, BACKEND_PORT } from "@lys/protocol"
import { getBackendStatus, startBackend, stopBackend } from "../apis"

/** Top-level view selected by the application store. */
export type AppView = "chat" | "settings"

/**
 * Backend lifecycle states tracked by the store.
 *
 * @remarks `running` means the backend's HTTP health route answered.
 * `unresponsive` means the process stayed alive without answering within the
 * readiness timeout; stopping it is the recovery path.
 */
export type BackendServerStatus =
  "running" | "starting" | "stopping" | "stopped" | "unresponsive"

/** Store-owned backend lifecycle timestamps and current status. */
export type BackendServerInfo = {
  /** Current backend lifecycle state. */
  status: BackendServerStatus
  /** Renderer timestamp assigned when the health route first answered. */
  startedAt?: Date
  /** Renderer timestamp assigned after a stop, or an exit before readiness. */
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
  /** True until settings load; a settings failure leaves it true and the shell blank. */
  initializing: boolean
  /** Backend lifecycle tracked by the store. */
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
   * Loads settings, shows the shell, then starts or checks the backend.
   *
   * @returns A promise resolving after settings load and any backend start settles.
   * @throws The settings or backend Tauri rejection.
   * @remarks The backend starts when autostart is on or a process already
   * runs; either way readiness is established through the health route.
   */
  initialize: () => Promise<void>
  /**
   * Starts the backend process when needed and waits until its health route
   * answers, it exits, or the readiness timeout passes.
   *
   * @returns A promise resolving after the status is `running`,
   * `unresponsive`, or `stopped`, and after the LM Studio status is read when running.
   * @throws The Tauri status or start rejection; the status then stays `starting`.
   */
  startBackend: () => Promise<void>
  /**
   * Stops the backend when its process runs; a still-running result leaves the stop transition pending.
   * A process that already exited, for example after it was reported
   * unresponsive, is published as stopped.
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
type LysStore = LysState &
  LysActions &
  ModelSlice &
  GenerationSettingsSlice &
  LmStudioStatusSlice

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
 * Zustand hook and store for application view, settings, backend lifecycle,
 * and LM Studio status.
 *
 * @remarks Initialization and process actions are application-owned
 * asynchronous transitions. Tauri errors propagate from the returned promises;
 * settings are edited in memory by setSettings. The generation slice owns
 * automatic saves and retains their completion or failure state across pane
 * changes.
 *
 * Model requests are owned by the model slice, use the shared HTTP protocol,
 * and are admitted only while the backend runs and LM Studio is connected.
 * An LM Studio status change to `connected` refreshes inventory; any other
 * change releases model observations. A failed model request re-reads the
 * LM Studio status.
 */
export const useLysStore = create<LysStore>()((set, get) => {
  /**
   * Publishes one readiness outcome unless the start transition was superseded.
   *
   * @param readiness - Outcome observed for the started backend.
   * @returns A promise resolving after publication and, when ready, after the
   * LM Studio status is read.
   */
  async function updateBackendServerReadiness(
    readiness: BackendReadiness
  ): Promise<void> {
    if (get().backendServerInfo.status !== "starting") return
    switch (readiness) {
      case "ready":
        set({
          backendServerInfo: {
            status: "running",
            startedAt: new Date(),
            stoppedAt: undefined
          }
        })
        await get().updateLmStudioStatus()
        return
      case "unresponsive":
        set({
          backendServerInfo: {
            status: "unresponsive",
            startedAt: undefined,
            stoppedAt: undefined
          }
        })
        return
      case "exited":
        set({
          backendServerInfo: {
            status: "stopped",
            startedAt: undefined,
            stoppedAt: new Date()
          }
        })
        return
    }
  }

  /**
   * Publishes a stopped backend once no backend process remains.
   *
   * @param stoppedAt - Renderer time at which the process was found gone.
   */
  function handleBackendProcessExit(stoppedAt: Date): void {
    get().resetLmStudioStatus()
    // LM Studio owns weights separately; discard observations until reconnect.
    get().releaseModelRuntime()
    set((prev) => ({
      ...prev,
      backendServerInfo: {
        ...prev.backendServerInfo,
        status: "stopped",
        stoppedAt
      }
    }))
  }

  /**
   * Refreshes model observations when LM Studio connects and releases them otherwise.
   *
   * @param lmStudioStatus - Newly published LM Studio status.
   */
  function handleLmStudioStatusChange(lmStudioStatus: LmStudioStatus): void {
    if (lmStudioStatus === "connected") {
      void get().updateModelInventory()
      return
    }
    get().releaseModelRuntime()
  }

  return {
    ...initialState,
    ...createGenerationSettingsSlice(set, get),
    ...createModelSlice(set, get, {
      getConnection: () => ({
        backendUrl: get().backendUrl,
        isModelRuntimeAvailable:
          get().backendServerInfo.status === "running" &&
          get().lmStudioStatus === "connected",
        defaultModel: get().settings.runtime.defaultModel
      }),
      handleModelRequestFailure: async () => {
        await get().updateLmStudioStatus()
      }
    }),
    ...createLmStudioStatusSlice(set, get, {
      getBackendConnection: () => ({
        backendUrl: get().backendUrl,
        isBackendRunning: get().backendServerInfo.status === "running"
      }),
      handleLmStudioStatusChange
    }),

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
      set({
        backendServerInfo: {
          status: "starting",
          startedAt: undefined,
          stoppedAt: undefined
        }
      })
      const isProcessRunning =
        (await getBackendStatus()).running || (await startBackend()).running
      const readiness = isProcessRunning
        ? await getBackendReadiness(get().backendUrl)
        : "exited"
      await updateBackendServerReadiness(readiness)
    },

    stopBackend: async () => {
      if (!(await getBackendStatus()).running) {
        if (get().backendServerInfo.status !== "stopped") {
          handleBackendProcessExit(new Date())
        }
        return
      }

      set((prev) => ({
        ...prev,
        backendServerInfo: {
          ...prev.backendServerInfo,
          status: "stopping"
        }
      }))
      get().resetLmStudioStatus()
      get().releaseModelRuntime()
      const processStatus = await stopBackend()
      const now = new Date()
      if (!processStatus.running) handleBackendProcessExit(now)
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
      set({ settings, initializing: false })
      if (
        settings.runtime.autoStartBackend ||
        (await getBackendStatus()).running
      ) {
        await get().startBackend()
      }
    }
  }
})
