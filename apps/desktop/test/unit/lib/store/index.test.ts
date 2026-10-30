import { afterEach, describe, expect, it, vi } from "vitest"
import type { BackendServerInfo } from "@/lib/store"
import type { LysSettings, RuntimeSettings } from "@/lib/store/settings"
import type { VmoServerInfo } from "@/lib/store/vmo-runtime"
import {
  buildJsonResponse,
  createTransportFailure,
  FIXTURE_BACKEND_URL,
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
  createSettlementReader,
  waitForMicrotasks
} from "../../support/settlement"
import {
  STORED_SETTINGS,
  STORED_SETTINGS_DOCUMENT,
  type SettingsDocument
} from "../../support/settingsFixtures"

/** Origin the application store uses for the local backend. */
const BACKEND_URL = "http://127.0.0.1:12345"

/** Runtime group on disk with autostart off and a listed default model. */
const DISK_RUNTIME_SETTINGS: RuntimeSettings = Object.freeze({
  autoStartBackend: false,
  autoStartVmo: false,
  defaultModel: "on-disk",
  backendAddress: BACKEND_URL
})

/** Settings document on disk with autostart off and a default model chosen. */
const DISK_SETTINGS_DOCUMENT: SettingsDocument = Object.freeze({
  ...STORED_SETTINGS_DOCUMENT,
  runtime: DISK_RUNTIME_SETTINGS
})

/** The store's settings once {@link DISK_SETTINGS_DOCUMENT} is loaded. */
const DISK_SETTINGS: LysSettings = Object.freeze({
  ...STORED_SETTINGS,
  runtime: DISK_RUNTIME_SETTINGS
})

/** Runtime group on disk with backend autostart on. */
const BACKEND_AUTOSTART_RUNTIME_SETTINGS: RuntimeSettings = Object.freeze({
  ...DISK_RUNTIME_SETTINGS,
  autoStartBackend: true
})

/** Settings document on disk with backend autostart on. */
const AUTOSTART_SETTINGS_DOCUMENT: SettingsDocument = Object.freeze({
  ...DISK_SETTINGS_DOCUMENT,
  runtime: BACKEND_AUTOSTART_RUNTIME_SETTINGS
})

/** Runtime group on disk with only vmo autostart on. */
const VMO_AUTOSTART_RUNTIME_SETTINGS: RuntimeSettings = Object.freeze({
  ...DISK_RUNTIME_SETTINGS,
  autoStartVmo: true
})

/** Settings document on disk with only vmo autostart on. */
const VMO_AUTOSTART_SETTINGS_DOCUMENT: SettingsDocument = Object.freeze({
  ...DISK_SETTINGS_DOCUMENT,
  runtime: VMO_AUTOSTART_RUNTIME_SETTINGS
})

/** Runtime group on disk with backend and vmo autostart on. */
const BOTH_AUTOSTART_RUNTIME_SETTINGS: RuntimeSettings = Object.freeze({
  ...DISK_RUNTIME_SETTINGS,
  autoStartBackend: true,
  autoStartVmo: true
})

/** Settings document on disk with backend and vmo autostart on. */
const BOTH_AUTOSTART_SETTINGS_DOCUMENT: SettingsDocument = Object.freeze({
  ...DISK_SETTINGS_DOCUMENT,
  runtime: BOTH_AUTOSTART_RUNTIME_SETTINGS
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
  "GET /api/v1/llm/list": () =>
    buildJsonResponse(200, { llms: INVENTORY, modelLoading: "lys" })
})

/**
 * Loads a fresh application store, so no state or pending work of another
 * case reaches this one.
 *
 * @returns The store hook of a newly evaluated store module.
 */
async function loadFreshLysStore() {
  vi.resetModules()
  const { useLysStore } = await import("@/lib/store")
  return useLysStore
}

/**
 * Starts a native host whose backend process and vmo are stopped until
 * started; a started vmo answers its health route at once.
 *
 * @param settingsDocument - Settings document `load_settings` returns.
 * @param commands - Commands replacing the defaults.
 * @returns The host observation handle.
 */
function startDesktopHost(
  settingsDocument: SettingsDocument,
  commands: NativeCommands = {}
) {
  let isRunning = false
  let isVmoRunning = false
  return startNativeHostFake({
    load_settings: () => settingsDocument,
    get_backend_status: () => ({ running: isRunning }),
    start_backend: () => {
      isRunning = true
      return { pid: 4242, running: true }
    },
    stop_backend: () => {
      isRunning = false
      return { running: false }
    },
    get_vmo_status: () =>
      isVmoRunning ? { status: "running", pid: 4343 } : { status: "stopped" },
    start_vmo: () => {
      isVmoRunning = true
      return { status: "running", pid: 4343 }
    },
    get_vmo_health: () => "ready",
    ...commands
  })
}

/** Reason a failed spawn of the backend process rejects with. */
const SPAWN_FAILURE = "Failed to spawn the backend"

/** Reason a failed read of the backend process status rejects with. */
const STATUS_FAILURE = "Failed to inspect backend process: Resource busy"

/** Reason a failed stop of the backend process rejects with. */
const STOP_FAILURE =
  "Failed to terminate backend process group 4242: Operation not permitted"

/**
 * Statuses from which the Runtime pane offers Start (`stopped`) or Stop
 * (`running`, `unresponsive`).
 */
const ACTIONABLE_BACKEND_STATUSES = ["stopped", "running", "unresponsive"]

/** Starts a native host whose backend process cannot be spawned. */
function startHostFailingSpawn(): void {
  startDesktopHost(DISK_SETTINGS_DOCUMENT, {
    start_backend: () => Promise.reject(SPAWN_FAILURE)
  })
}

/**
 * Starts a native host whose backend process spawns but whose status cannot
 * be read while the start waits for the health route, which does not answer.
 */
function startHostFailingStatusAfterSpawn(): void {
  let isSpawned = false
  startBackendFake({
    "GET /api/v1/heath": () => new Response(null, { status: 503 })
  })
  startDesktopHost(DISK_SETTINGS_DOCUMENT, {
    get_backend_status: () =>
      isSpawned ? Promise.reject(STATUS_FAILURE) : { running: false },
    start_backend: () => {
      isSpawned = true
      return { pid: 4242, running: true }
    }
  })
}

/** Native failures during a start, with the reason the start rejects with. */
const START_FAILURES = [
  ["the process cannot be spawned", startHostFailingSpawn, SPAWN_FAILURE],
  [
    "the process status cannot be read while waiting for an answer",
    startHostFailingStatusAfterSpawn,
    STATUS_FAILURE
  ]
] as const

/**
 * Starts a running backend whose process then cannot be stopped.
 *
 * @returns The store, with the backend running.
 */
async function startBackendFailingStop() {
  startBackendFake(CONNECTED_BACKEND)
  startDesktopHost(DISK_SETTINGS_DOCUMENT, {
    stop_backend: () => Promise.reject(STOP_FAILURE)
  })
  const useLysStore = await loadFreshLysStore()
  await useLysStore.getState().startBackend()
  return useLysStore
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
    const useLysStore = await loadFreshLysStore()

    expect(useLysStore.getState()).toMatchObject({
      activeView: "chat",
      settingsPane: "runtime",
      backendUrl: BACKEND_URL,
      initializing: true,
      backendServerInfo: { status: "stopped" },
      lmStudioStatus: "unknown",
      modelRuntime: { status: "unavailable" },
      settings: {
        runtime: { autoStartBackend: true, defaultModel: null },
        generation: { temperature: 0.7, replyCeiling: 2048 }
      }
    })
    expect(useLysStore.getState().settings.loadConfiguration).toEqual({
      default: {},
      models: new Map()
    })
    expect(useLysStore.getState().settings.secrets).toEqual({
      tavilyApiKey: null,
      ollamaApiKey: null,
      groqApiKey: null
    })
    expect(useLysStore.getState().settings.providers).toEqual({
      active: "lmStudio",
      lmStudio: { address: null },
      ollama: { mode: "local", address: null }
    })
  })

  it("selects the view and the settings pane", async () => {
    const useLysStore = await loadFreshLysStore()

    useLysStore.getState().setActiveView("settings")
    useLysStore.getState().setSettingsPane("generation")

    expect(useLysStore.getState()).toMatchObject({
      activeView: "settings",
      settingsPane: "generation"
    })
  })

  describe("initialize", () => {
    it("shows the shell with the loaded settings and leaves a stopped backend and vmo alone without autostart", async () => {
      const host = startDesktopHost(DISK_SETTINGS_DOCUMENT)
      const useLysStore = await loadFreshLysStore()

      await useLysStore.getState().initialize()

      const stoppedBackend: BackendServerInfo = { status: "stopped" }
      const stoppedVmo: VmoServerInfo = { status: "stopped", problem: null }
      expect(useLysStore.getState()).toMatchObject({
        initializing: false,
        settings: DISK_SETTINGS,
        backendServerInfo: stoppedBackend,
        vmoServerInfo: stoppedVmo
      })
      expect(listCommandNames(host)).toEqual([
        "load_settings",
        "get_backend_status",
        "get_vmo_status"
      ])
    })

    it("starts vmo with its autostart alongside the backend, and the backend does not wait for vmo", async () => {
      startBackendFake(CONNECTED_BACKEND)
      const vmoHealth = createControlledPromise<unknown>()
      const host = startDesktopHost(BOTH_AUTOSTART_SETTINGS_DOCUMENT, {
        get_vmo_health: () => vmoHealth.promise
      })
      const useLysStore = await loadFreshLysStore()

      const initialization = useLysStore.getState().initialize()
      const getSettlement = createSettlementReader(initialization)
      await vi.waitFor(() => {
        expect(useLysStore.getState().backendServerInfo.status).toBe("running")
      })
      const whileVmoStarts = useLysStore.getState().vmoServerInfo
      const settlementWhileVmoStarts = getSettlement()
      vmoHealth.resolve("ready")
      await initialization

      expect(whileVmoStarts).toEqual({ status: "starting", problem: null })
      expect(settlementWhileVmoStarts).toBe("pending")
      expect(useLysStore.getState().vmoServerInfo).toEqual({
        status: "running",
        problem: null
      })
      expect(listCommandNames(host)).toContain("start_vmo")
    })

    it("starts vmo while the backend's start is still pending", async () => {
      const backendStart = createControlledPromise<unknown>()
      startBackendFake(CONNECTED_BACKEND)
      startDesktopHost(BOTH_AUTOSTART_SETTINGS_DOCUMENT, {
        start_backend: () => backendStart.promise
      })
      const useLysStore = await loadFreshLysStore()

      const initialization = useLysStore.getState().initialize()
      await vi.waitFor(() => {
        expect(useLysStore.getState().vmoServerInfo.status).toBe("running")
      })
      const backendWhileVmoRuns = useLysStore.getState().backendServerInfo
      backendStart.resolve({ pid: 4242, running: true })
      await initialization

      expect(backendWhileVmoRuns.status).toBe("starting")
      expect(useLysStore.getState().backendServerInfo.status).toBe("running")
    })

    it("adopts a vmo the desktop already owns, without autostart", async () => {
      const host = startDesktopHost(DISK_SETTINGS_DOCUMENT, {
        get_vmo_status: () => ({ status: "running", pid: 4343 })
      })
      const useLysStore = await loadFreshLysStore()

      await useLysStore.getState().initialize()

      expect(useLysStore.getState().vmoServerInfo.status).toBe("running")
      expect(listCommandNames(host)).not.toContain("start_vmo")
    })

    it("joins a vmo stop still in progress after a reload instead of starting vmo, even with its autostart on", async () => {
      const host = startDesktopHost(VMO_AUTOSTART_SETTINGS_DOCUMENT, {
        get_vmo_status: () => ({ status: "stopping", pid: 4343 }),
        stop_vmo: () => ({ status: "stopped" })
      })
      const useLysStore = await loadFreshLysStore()

      await useLysStore.getState().initialize()

      expect(useLysStore.getState().vmoServerInfo).toEqual({
        status: "stopped",
        problem: null
      })
      expect(listCommandNames(host)).toContain("stop_vmo")
      expect(listCommandNames(host)).not.toContain("start_vmo")
    })

    it("rejects with the backend's start rejection once vmo's start has settled too", async () => {
      startDesktopHost(BOTH_AUTOSTART_SETTINGS_DOCUMENT, {
        start_backend: () => Promise.reject(SPAWN_FAILURE)
      })
      const useLysStore = await loadFreshLysStore()

      await expect(useLysStore.getState().initialize()).rejects.toBe(
        SPAWN_FAILURE
      )
      expect(useLysStore.getState().vmoServerInfo.status).toBe("running")
    })

    it("rejects with the vmo status rejection when it cannot be read", async () => {
      startDesktopHost(DISK_SETTINGS_DOCUMENT, {
        get_vmo_status: () => Promise.reject("Failed to inspect vmo process")
      })
      const useLysStore = await loadFreshLysStore()

      await expect(useLysStore.getState().initialize()).rejects.toBe(
        "Failed to inspect vmo process"
      )
      expect(useLysStore.getState().vmoServerInfo).toEqual({
        status: "stopped",
        problem: null
      })
    })

    it("starts the backend when autostart is on, showing the shell first", async () => {
      startBackendFake(CONNECTED_BACKEND)
      const start = createControlledPromise<unknown>()
      startDesktopHost(AUTOSTART_SETTINGS_DOCUMENT, {
        start_backend: () => start.promise
      })
      const useLysStore = await loadFreshLysStore()

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
      const host = startDesktopHost(DISK_SETTINGS_DOCUMENT, {
        get_backend_status: () => ({ pid: 7, running: true })
      })
      const useLysStore = await loadFreshLysStore()

      await useLysStore.getState().initialize()

      expect(useLysStore.getState().backendServerInfo.status).toBe("running")
      expect(listCommandNames(host)).not.toContain("start_backend")
    })

    // #163 asks for an error screen in this case instead of a blank window;
    // the state the shell reads to show it may change with that.
    it("rejects and stays initializing when the settings cannot be loaded", async () => {
      startDesktopHost(DISK_SETTINGS_DOCUMENT, {
        load_settings: () => Promise.reject("Failed to parse settings.json")
      })
      const useLysStore = await loadFreshLysStore()

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
      const host = startDesktopHost(DISK_SETTINGS_DOCUMENT)
      const useLysStore = await loadFreshLysStore()
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
        modelInventory: {
          status: "ready",
          modelLoading: "lys",
          models: INVENTORY
        }
      })
    })

    it("publishes stopped when the process exits before answering", async () => {
      startBackendFake({
        "GET /api/v1/heath": () => new Response(null, { status: 503 })
      })
      startDesktopHost(DISK_SETTINGS_DOCUMENT, {
        start_backend: () => ({ running: false })
      })
      const useLysStore = await loadFreshLysStore()

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
      startDesktopHost(DISK_SETTINGS_DOCUMENT, {
        get_backend_status: () => ({ pid: 7, running: true })
      })
      const useLysStore = await loadFreshLysStore()

      const start = useLysStore.getState().startBackend()
      await vi.advanceTimersByTimeAsync(30_000)
      await start

      expect(useLysStore.getState().backendServerInfo.status).toBe(
        "unresponsive"
      )
    })

    it.each(START_FAILURES)(
      "rejects with the native reason when %s",
      async (_failure, startHost, reason) => {
        startHost()
        const useLysStore = await loadFreshLysStore()

        await expect(useLysStore.getState().startBackend()).rejects.toBe(reason)
      }
    )

    // Known defect (#162): the status stays `starting`, from which the
    // Runtime pane offers neither Start nor Stop, so only restarting the app
    // leaves it.
    it.fails.each(START_FAILURES)(
      "leaves a status the Runtime pane can start or stop from when %s",
      async (_failure, startHost) => {
        startHost()
        const useLysStore = await loadFreshLysStore()

        await Promise.allSettled([useLysStore.getState().startBackend()])

        expect(ACTIONABLE_BACKEND_STATUSES).toContain(
          useLysStore.getState().backendServerInfo.status
        )
      }
    )

    it("does not publish readiness after a stop superseded the start", async () => {
      const health = createControlledPromise<Response>()
      startBackendFake({ "GET /api/v1/heath": () => health.promise })
      startDesktopHost(DISK_SETTINGS_DOCUMENT)
      const useLysStore = await loadFreshLysStore()
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
      const host = startDesktopHost(DISK_SETTINGS_DOCUMENT)
      const useLysStore = await loadFreshLysStore()
      await useLysStore.getState().startBackend()
      await waitForMicrotasks()

      await useLysStore.getState().stopBackend()

      expect(listCommandNames(host).at(-1)).toBe("stop_backend")
      expect(useLysStore.getState()).toMatchObject({
        backendServerInfo: { status: "stopped", stoppedAt: expect.any(Date) },
        lmStudioStatus: "unknown",
        modelInventory: { status: "unavailable" },
        modelRuntime: { status: "unavailable" }
      })
    })

    it("rejects with the native reason when the process cannot be stopped", async () => {
      const useLysStore = await startBackendFailingStop()

      await expect(useLysStore.getState().stopBackend()).rejects.toBe(
        STOP_FAILURE
      )
    })

    // Known defect (#162): the status stays `stopping`, from which the
    // Runtime pane offers neither Start nor Stop, so only restarting the app
    // leaves it.
    it.fails(
      "leaves a status the Runtime pane can start or stop from when the process cannot be stopped",
      async () => {
        const useLysStore = await startBackendFailingStop()

        await Promise.allSettled([useLysStore.getState().stopBackend()])

        expect(ACTIONABLE_BACKEND_STATUSES).toContain(
          useLysStore.getState().backendServerInfo.status
        )
      }
    )

    it("publishes stopped for an unresponsive backend whose process already exited", async () => {
      vi.useFakeTimers()
      startBackendFake({
        "GET /api/v1/heath": () => new Response(null, { status: 503 })
      })
      let isRunning = true
      const host = startDesktopHost(DISK_SETTINGS_DOCUMENT, {
        get_backend_status: () => ({ running: isRunning })
      })
      const useLysStore = await loadFreshLysStore()
      const start = useLysStore.getState().startBackend()
      await vi.advanceTimersByTimeAsync(30_000)
      await start
      isRunning = false

      await useLysStore.getState().stopBackend()

      expect(useLysStore.getState().backendServerInfo.status).toBe("stopped")
      expect(listCommandNames(host)).not.toContain("stop_backend")
    })

    it("changes nothing when the backend is already stopped", async () => {
      startDesktopHost(DISK_SETTINGS_DOCUMENT)
      const useLysStore = await loadFreshLysStore()
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
      startDesktopHost(DISK_SETTINGS_DOCUMENT)
      const useLysStore = await loadFreshLysStore()
      await useLysStore.getState().startBackend()

      vi.setSystemTime(new Date("2026-05-06T07:01:30.000Z"))
      const whileRunning = useLysStore.getState().getBackendUptimeMs()
      await useLysStore.getState().stopBackend()
      vi.setSystemTime(new Date("2026-05-06T08:00:00.000Z"))

      expect(whileRunning).toBe(90_000)
      expect(useLysStore.getState().getBackendUptimeMs()).toBe(90_000)
    })

    it("reports zero before the backend ever answered", async () => {
      const useLysStore = await loadFreshLysStore()

      expect(useLysStore.getState().getBackendUptimeMs()).toBe(0)
    })
  })

  describe("setSettings", () => {
    it("saves a generation edit to disk and reports the save", async () => {
      const host = startDesktopHost(DISK_SETTINGS_DOCUMENT, {
        save_settings: () => null
      })
      const useLysStore = await loadFreshLysStore()
      await useLysStore.getState().initialize()
      const generation = { temperature: 0.9, replyCeiling: 0 }
      const edited = { ...DISK_SETTINGS, generation }

      useLysStore.getState().setSettings(edited)
      const applied = useLysStore.getState().settings
      await waitForMicrotasks()

      expect(applied).toEqual(edited)
      expect(host.commands.at(-1)).toEqual({
        command: "save_settings",
        args: { newSettings: { ...DISK_SETTINGS_DOCUMENT, generation } }
      })
      expect(useLysStore.getState().generationSave).toEqual({ status: "saved" })
    })

    it("saves a tools edit to disk and reports the save", async () => {
      const host = startDesktopHost(DISK_SETTINGS_DOCUMENT, {
        save_settings: () => null
      })
      const useLysStore = await loadFreshLysStore()
      await useLysStore.getState().initialize()

      useLysStore.getState().setSettings({
        ...DISK_SETTINGS,
        tools: {
          justRunToolNames: new Set(["find_files"]),
          switches: new Map([["web_search", true]])
        }
      })
      await waitForMicrotasks()

      expect(host.commands.at(-1)).toEqual({
        command: "save_settings",
        args: {
          newSettings: {
            ...DISK_SETTINGS_DOCUMENT,
            tools: { justRun: ["find_files"], switches: { web_search: true } }
          }
        }
      })
      expect(useLysStore.getState().toolSettingsSave).toEqual({
        status: "saved"
      })
    })

    it("saves a startup switch edit to disk and reports the save", async () => {
      const host = startDesktopHost(DISK_SETTINGS_DOCUMENT, {
        save_settings: () => null
      })
      const useLysStore = await loadFreshLysStore()
      await useLysStore.getState().initialize()
      const runtime = { ...DISK_RUNTIME_SETTINGS, autoStartVmo: true }

      useLysStore.getState().setSettings({ ...DISK_SETTINGS, runtime })
      await waitForMicrotasks()

      const newSettings: SettingsDocument = {
        ...DISK_SETTINGS_DOCUMENT,
        runtime
      }
      const saveSettingsArgs = { newSettings }
      expect(host.commands.at(-1)).toEqual({
        command: "save_settings",
        args: saveSettingsArgs
      })
      expect(useLysStore.getState().runtimeAutoStartSave).toEqual({
        status: "saved"
      })
    })

    it("keeps default model edits in memory without saving them", async () => {
      const host = startDesktopHost(DISK_SETTINGS_DOCUMENT)
      const useLysStore = await loadFreshLysStore()
      await useLysStore.getState().initialize()

      const runtime: RuntimeSettings = {
        ...DISK_RUNTIME_SETTINGS,
        defaultModel: "resident"
      }
      useLysStore.getState().setSettings({ ...DISK_SETTINGS, runtime })
      await waitForMicrotasks()

      expect(useLysStore.getState().settings.runtime.defaultModel).toBe(
        "resident"
      )
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
            ],
            modelLoading: "lys"
          })
      })
      startDesktopHost(DISK_SETTINGS_DOCUMENT)
      const useLysStore = await loadFreshLysStore()
      await useLysStore.getState().initialize()
      await useLysStore.getState().startBackend()
      await waitForMicrotasks()
      const before = useLysStore.getState().modelRuntime

      useLysStore.getState().setSettings({
        ...useLysStore.getState().settings,
        runtime: { ...DISK_RUNTIME_SETTINGS, defaultModel: "later" }
      })

      expect(before).toEqual({ status: "loaded", modelKey: "on-disk" })
      expect(useLysStore.getState().modelRuntime).toEqual({
        status: "loaded",
        modelKey: "later"
      })
    })
  })

  describe("secrets", () => {
    it("checks the saved key at the application store's current backend", async () => {
      const backend = startBackendFake({
        "POST /api/v1/tools/web_search/key-check": () =>
          buildJsonResponse(200, { status: "rejected" })
      })
      const useLysStore = await loadFreshLysStore()
      useLysStore.setState({ backendUrl: FIXTURE_BACKEND_URL })

      await useLysStore.getState().sendTavilyKeyCheck()

      expect(backend.requests.map((request) => request.url)).toEqual([
        `${FIXTURE_BACKEND_URL}/api/v1/tools/web_search/key-check`
      ])
      expect(useLysStore.getState().tavilyKeyCheck).toEqual({
        status: "checked",
        outcome: { status: "rejected" }
      })
    })

    it("saves a key removal to disk in the store's settings", async () => {
      const host = startDesktopHost(DISK_SETTINGS_DOCUMENT, {
        save_settings: () => null
      })
      const useLysStore = await loadFreshLysStore()
      await useLysStore.getState().initialize()

      await expect(useLysStore.getState().saveTavilyApiKey(null)).resolves.toBe(
        "saved"
      )

      expect(host.commands.at(-1)).toEqual({
        command: "save_settings",
        args: {
          newSettings: {
            ...DISK_SETTINGS_DOCUMENT,
            secrets: { ...DISK_SETTINGS_DOCUMENT.secrets, tavilyApiKey: null }
          }
        }
      })
      expect(useLysStore.getState().settings.secrets).toEqual({
        ...DISK_SETTINGS.secrets,
        tavilyApiKey: null
      })
    })
  })

  describe("tool approvals", () => {
    it("saves a tool put on Just run to disk in the store's settings", async () => {
      const host = startDesktopHost(DISK_SETTINGS_DOCUMENT, {
        save_settings: () => null
      })
      const useLysStore = await loadFreshLysStore()
      await useLysStore.getState().initialize()

      useLysStore.getState().updateToolApproval("find_files", "run")
      await waitForMicrotasks()

      expect(host.commands.at(-1)).toEqual({
        command: "save_settings",
        args: {
          newSettings: {
            ...DISK_SETTINGS_DOCUMENT,
            tools: {
              justRun: [...DISK_SETTINGS_DOCUMENT.tools.justRun, "find_files"],
              switches: DISK_SETTINGS_DOCUMENT.tools.switches
            }
          }
        }
      })
      expect(useLysStore.getState().toolSettingsSave).toEqual({
        status: "saved"
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
        "POST /api/v1/llm/load": () => Promise.reject(createTransportFailure())
      })
      startDesktopHost(DISK_SETTINGS_DOCUMENT)
      const useLysStore = await loadFreshLysStore()
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
