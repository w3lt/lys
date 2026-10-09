import { afterEach, describe, expect, it, vi } from "vitest"
import type { LysSettings } from "@/lib/store/settings"
import {
  buildJsonResponse,
  startBackendFake,
  type BackendRoutes
} from "../../support/backendFake"
import { buildLlmInfo } from "../../support/modelFixtures"
import {
  startNativeHostFake,
  type NativeCommands
} from "../../support/nativeHostFake"
import {
  createControlledPromise,
  waitForMicrotasks
} from "../../support/settlement"

/** Origin the application store uses for the local backend. */
const BACKEND_URL = "http://127.0.0.1:12345"

/** Settings on disk with autostart off and a default model chosen. */
const DISK_SETTINGS: LysSettings = Object.freeze({
  runtime: Object.freeze({
    autoStartBackend: false,
    defaultModel: "on-disk",
    backendAddress: BACKEND_URL
  }),
  model: Object.freeze({ contextSize: 4096 }),
  generation: Object.freeze({ temperature: 0.2, replyCeiling: 512 })
})

/** Settings on disk with autostart on. */
const AUTOSTART_SETTINGS: LysSettings = Object.freeze({
  ...DISK_SETTINGS,
  runtime: Object.freeze({ ...DISK_SETTINGS.runtime, autoStartBackend: true })
})

/** Inventory listed once LM Studio is connected. */
const INVENTORY = [
  buildLlmInfo("resident", { loaded: true }),
  buildLlmInfo("on-disk")
]

/** Backend that answers health, reports LM Studio connected, and lists models. */
const CONNECTED_BACKEND: BackendRoutes = Object.freeze({
  "GET /api/v1/heath": () => buildJsonResponse(200, { status: "ok" }),
  "GET /api/v1/llm/runtime": () =>
    buildJsonResponse(200, { status: "connected" }),
  "GET /api/v1/llm/list": () => buildJsonResponse(200, { llms: INVENTORY })
})

/**
 * Imports a fresh application store, so no state or pending work of another
 * case reaches this one.
 *
 * @returns The store hook of a newly evaluated store module.
 */
async function importFreshLysStore() {
  vi.resetModules()
  const { useLysStore } = await import("@/lib/store")
  return useLysStore
}

/**
 * Starts a native host whose backend process is stopped until started.
 *
 * @param settings - Settings document `load_settings` returns.
 * @param commands - Commands replacing the defaults.
 * @returns The host observation handle.
 */
function startDesktopHost(
  settings: LysSettings,
  commands: NativeCommands = {}
) {
  let isRunning = false
  return startNativeHostFake({
    load_settings: () => settings,
    get_backend_status: () => ({ running: isRunning }),
    start_backend: () => {
      isRunning = true
      return { pid: 4242, running: true }
    },
    stop_backend: () => {
      isRunning = false
      return { running: false }
    },
    ...commands
  })
}

/**
 * Lists the native commands the host received, in order.
 *
 * @param host - Native host observation handle.
 * @returns The command names.
 */
function listCommandNames(host: ReturnType<typeof startNativeHostFake>) {
  return host.commands.map((invoked) => invoked.command)
}

afterEach(() => {
  vi.useRealTimers()
})

describe("useLysStore", () => {
  it("starts on the chat view, initializing, with the backend stopped and default settings", async () => {
    const useLysStore = await importFreshLysStore()

    expect(useLysStore.getState()).toMatchObject({
      activeView: "chat",
      settingsPane: "runtime",
      backendUrl: BACKEND_URL,
      initializing: true,
      backendServerInfo: { status: "stopped" },
      lmStudioStatus: "unknown",
      modelRuntime: { status: "none" },
      settings: {
        runtime: { autoStartBackend: true, defaultModel: null },
        generation: { temperature: 0.7, replyCeiling: 2048 }
      }
    })
  })

  it("selects the view and the settings pane", async () => {
    const useLysStore = await importFreshLysStore()

    useLysStore.getState().setActiveView("settings")
    useLysStore.getState().setSettingsPane("generation")

    expect(useLysStore.getState()).toMatchObject({
      activeView: "settings",
      settingsPane: "generation"
    })
  })

  describe("initialize", () => {
    it("shows the shell with the loaded settings and leaves a stopped backend alone without autostart", async () => {
      const host = startDesktopHost(DISK_SETTINGS)
      const useLysStore = await importFreshLysStore()

      await useLysStore.getState().initialize()

      expect(useLysStore.getState()).toMatchObject({
        initializing: false,
        settings: DISK_SETTINGS,
        backendServerInfo: { status: "stopped" }
      })
      expect(listCommandNames(host)).toEqual([
        "load_settings",
        "get_backend_status"
      ])
    })

    it("starts the backend when autostart is on, showing the shell first", async () => {
      startBackendFake(CONNECTED_BACKEND)
      const start = createControlledPromise<unknown>()
      startDesktopHost(AUTOSTART_SETTINGS, {
        start_backend: () => start.promise
      })
      const useLysStore = await importFreshLysStore()

      const initialization = useLysStore.getState().initialize()
      await waitForMicrotasks()
      const whileStarting = useLysStore.getState()
      start.resolve({ pid: 4242, running: true })
      await initialization

      expect(whileStarting).toMatchObject({
        initializing: false,
        backendServerInfo: { status: "starting" }
      })
      expect(useLysStore.getState().backendServerInfo.status).toBe("running")
    })

    it("adopts a backend process that already runs, without autostart", async () => {
      startBackendFake(CONNECTED_BACKEND)
      const host = startDesktopHost(DISK_SETTINGS, {
        get_backend_status: () => ({ pid: 7, running: true })
      })
      const useLysStore = await importFreshLysStore()

      await useLysStore.getState().initialize()

      expect(useLysStore.getState().backendServerInfo.status).toBe("running")
      expect(listCommandNames(host)).not.toContain("start_backend")
    })

    it("stays blank and rejects when the settings cannot be loaded", async () => {
      startDesktopHost(DISK_SETTINGS, {
        load_settings: () => Promise.reject("Failed to parse settings.json")
      })
      const useLysStore = await importFreshLysStore()

      await expect(useLysStore.getState().initialize()).rejects.toBe(
        "Failed to parse settings.json"
      )
      expect(useLysStore.getState().initializing).toBe(true)
    })
  })

  describe("startBackend", () => {
    it("publishes running once the health route answers, then reads LM Studio and lists models", async () => {
      vi.useFakeTimers({ toFake: ["Date"] })
      vi.setSystemTime(new Date("2026-05-06T07:08:09.000Z"))
      startBackendFake(CONNECTED_BACKEND)
      const host = startDesktopHost(DISK_SETTINGS)
      const useLysStore = await importFreshLysStore()
      await useLysStore.getState().initialize()

      await useLysStore.getState().startBackend()
      await waitForMicrotasks()

      expect(listCommandNames(host)).toContain("start_backend")
      expect(useLysStore.getState()).toMatchObject({
        backendServerInfo: {
          status: "running",
          startedAt: new Date("2026-05-06T07:08:09.000Z"),
          stoppedAt: undefined
        },
        lmStudioStatus: "connected",
        modelInventory: { status: "ready", models: INVENTORY }
      })
    })

    it("publishes stopped when the process exits before answering", async () => {
      startBackendFake({
        "GET /api/v1/heath": () => new Response(null, { status: 503 })
      })
      startDesktopHost(DISK_SETTINGS, {
        start_backend: () => ({ running: false })
      })
      const useLysStore = await importFreshLysStore()

      await useLysStore.getState().startBackend()

      expect(useLysStore.getState().backendServerInfo).toMatchObject({
        status: "stopped",
        startedAt: undefined,
        stoppedAt: expect.any(Date)
      })
    })

    it("publishes unresponsive when a live process never answers within the readiness timeout", async () => {
      vi.useFakeTimers()
      startBackendFake({
        "GET /api/v1/heath": () => new Response(null, { status: 503 })
      })
      startDesktopHost(DISK_SETTINGS, {
        get_backend_status: () => ({ pid: 7, running: true })
      })
      const useLysStore = await importFreshLysStore()

      const start = useLysStore.getState().startBackend()
      await vi.advanceTimersByTimeAsync(30_000)
      await start

      expect(useLysStore.getState().backendServerInfo.status).toBe(
        "unresponsive"
      )
    })

    it("rejects and stays starting when the process cannot be started", async () => {
      startDesktopHost(DISK_SETTINGS, {
        start_backend: () => Promise.reject("Failed to spawn the backend")
      })
      const useLysStore = await importFreshLysStore()

      await expect(useLysStore.getState().startBackend()).rejects.toBe(
        "Failed to spawn the backend"
      )
      expect(useLysStore.getState().backendServerInfo.status).toBe("starting")
    })

    it("does not publish readiness after a stop superseded the start", async () => {
      const health = createControlledPromise<Response>()
      startBackendFake({ "GET /api/v1/heath": () => health.promise })
      startDesktopHost(DISK_SETTINGS)
      const useLysStore = await importFreshLysStore()
      const start = useLysStore.getState().startBackend()
      await waitForMicrotasks()

      await useLysStore.getState().stopBackend()
      health.resolve(buildJsonResponse(200, { status: "ok" }))
      await start

      expect(useLysStore.getState().backendServerInfo.status).toBe("stopped")
    })
  })

  describe("stopBackend", () => {
    it("stops a running backend and releases the LM Studio and model observations", async () => {
      startBackendFake(CONNECTED_BACKEND)
      const host = startDesktopHost(DISK_SETTINGS)
      const useLysStore = await importFreshLysStore()
      await useLysStore.getState().startBackend()
      await waitForMicrotasks()

      await useLysStore.getState().stopBackend()

      expect(listCommandNames(host).at(-1)).toBe("stop_backend")
      expect(useLysStore.getState()).toMatchObject({
        backendServerInfo: { status: "stopped", stoppedAt: expect.any(Date) },
        lmStudioStatus: "unknown",
        modelInventory: { status: "unavailable" },
        modelRuntime: { status: "none" }
      })
    })

    it("stays stopping while the process still runs after the stop command", async () => {
      startBackendFake(CONNECTED_BACKEND)
      startDesktopHost(DISK_SETTINGS, {
        stop_backend: () => ({ pid: 4242, running: true })
      })
      const useLysStore = await importFreshLysStore()
      await useLysStore.getState().startBackend()

      await useLysStore.getState().stopBackend()

      expect(useLysStore.getState().backendServerInfo.status).toBe("stopping")
    })

    it("publishes stopped for an unresponsive backend whose process already exited", async () => {
      vi.useFakeTimers()
      startBackendFake({
        "GET /api/v1/heath": () => new Response(null, { status: 503 })
      })
      let isRunning = true
      const host = startDesktopHost(DISK_SETTINGS, {
        get_backend_status: () => ({ running: isRunning })
      })
      const useLysStore = await importFreshLysStore()
      const start = useLysStore.getState().startBackend()
      await vi.advanceTimersByTimeAsync(30_000)
      await start
      isRunning = false

      await useLysStore.getState().stopBackend()

      expect(useLysStore.getState().backendServerInfo.status).toBe("stopped")
      expect(listCommandNames(host)).not.toContain("stop_backend")
    })

    it("changes nothing when the backend is already stopped", async () => {
      startDesktopHost(DISK_SETTINGS)
      const useLysStore = await importFreshLysStore()
      const before = useLysStore.getState().backendServerInfo

      await useLysStore.getState().stopBackend()

      expect(useLysStore.getState().backendServerInfo).toBe(before)
    })
  })

  describe("getBackendUptimeMs", () => {
    it("counts from the start while running and freezes at the stop", async () => {
      vi.useFakeTimers({ toFake: ["Date"] })
      vi.setSystemTime(new Date("2026-05-06T07:00:00.000Z"))
      startBackendFake(CONNECTED_BACKEND)
      startDesktopHost(DISK_SETTINGS)
      const useLysStore = await importFreshLysStore()
      await useLysStore.getState().startBackend()

      vi.setSystemTime(new Date("2026-05-06T07:01:30.000Z"))
      const whileRunning = useLysStore.getState().getBackendUptimeMs()
      await useLysStore.getState().stopBackend()
      vi.setSystemTime(new Date("2026-05-06T08:00:00.000Z"))

      expect(whileRunning).toBe(90_000)
      expect(useLysStore.getState().getBackendUptimeMs()).toBe(90_000)
    })

    it("reports zero before the backend ever answered", async () => {
      const useLysStore = await importFreshLysStore()

      expect(useLysStore.getState().getBackendUptimeMs()).toBe(0)
    })
  })

  describe("setSettings", () => {
    it("saves a generation edit to disk and reports the save", async () => {
      const host = startDesktopHost(DISK_SETTINGS, {
        save_settings: () => null
      })
      const useLysStore = await importFreshLysStore()
      await useLysStore.getState().initialize()
      const edited = {
        ...DISK_SETTINGS,
        generation: { temperature: 0.9, replyCeiling: 0 }
      }

      useLysStore.getState().setSettings(edited)
      const applied = useLysStore.getState().settings
      await waitForMicrotasks()

      expect(applied).toEqual(edited)
      expect(host.commands.at(-1)).toEqual({
        command: "save_settings",
        args: { newSettings: edited }
      })
      expect(useLysStore.getState().generationSave).toEqual({ status: "saved" })
    })

    it("keeps runtime and model edits in memory without saving them", async () => {
      const host = startDesktopHost(DISK_SETTINGS)
      const useLysStore = await importFreshLysStore()
      await useLysStore.getState().initialize()

      useLysStore.getState().setSettings({
        ...DISK_SETTINGS,
        runtime: { ...DISK_SETTINGS.runtime, autoStartBackend: true },
        model: { contextSize: 8192 }
      })
      await waitForMicrotasks()

      expect(useLysStore.getState().settings.model.contextSize).toBe(8192)
      expect(listCommandNames(host)).not.toContain("save_settings")
    })

    it("re-derives the resident model summary from a new default model", async () => {
      startBackendFake({
        ...CONNECTED_BACKEND,
        "GET /api/v1/llm/list": () =>
          buildJsonResponse(200, {
            llms: [
              buildLlmInfo("first", { loaded: true }),
              buildLlmInfo("on-disk", { loaded: true }),
              buildLlmInfo("later", { loaded: true })
            ]
          })
      })
      startDesktopHost(DISK_SETTINGS)
      const useLysStore = await importFreshLysStore()
      await useLysStore.getState().initialize()
      await useLysStore.getState().startBackend()
      await waitForMicrotasks()
      const before = useLysStore.getState().modelRuntime

      useLysStore.getState().setSettings({
        ...useLysStore.getState().settings,
        runtime: { ...DISK_SETTINGS.runtime, defaultModel: "later" }
      })

      expect(before).toEqual({ status: "loaded", modelKey: "on-disk" })
      expect(useLysStore.getState().modelRuntime).toEqual({
        status: "loaded",
        modelKey: "later"
      })
    })
  })

  describe("LM Studio and model coordination", () => {
    it("re-reads the LM Studio status after a model request fails", async () => {
      let isConnected = true
      startBackendFake({
        ...CONNECTED_BACKEND,
        "GET /api/v1/llm/runtime": () =>
          buildJsonResponse(200, {
            status: isConnected ? "connected" : "unreachable"
          }),
        "POST /api/v1/llm/load": () =>
          Promise.reject(new TypeError("fetch failed"))
      })
      startDesktopHost(DISK_SETTINGS)
      const useLysStore = await importFreshLysStore()
      await useLysStore.getState().startBackend()
      await waitForMicrotasks()
      isConnected = false

      await useLysStore.getState().loadModel("on-disk")

      expect(useLysStore.getState()).toMatchObject({
        lmStudioStatus: "unreachable",
        modelInventory: { status: "unavailable" }
      })
    })
  })
})
