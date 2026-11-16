import { checkEmailAccountApiResponseSchema } from "@lys/protocol"
import { llmProviderSettingsSchema } from "@lys/share"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { BackendServerInfo } from "@/lib/store"
import type {
  GenerationSettings,
  LocationSettings,
  LysSettings,
  RuntimeSettings
} from "@/lib/store/settings"
import { INITIAL_PROVIDER_MODEL_STATES } from "@/lib/store/model-runtime"
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
  type NativeCommand,
  type NativeCommands
} from "../../support/nativeHostFake"
import {
  createControlledPromise,
  createSettlementReader,
  waitForMicrotasks
} from "../../support/settlement"
import { buildProviderStatusRoutes } from "../../support/providerModelFixtures"
import {
  isSettingsWrite,
  STORED_EMAIL_ACCOUNT,
  STORED_EMAIL_PASSWORD,
  STORED_SETTINGS,
  STORED_SETTINGS_DOCUMENT,
  type SettingsDocument
} from "../../support/settingsFixtures"

/** Origin the application store uses for the local backend. */
const BACKEND_URL = "http://127.0.0.1:12345"

/** Runtime group on disk with autostart off and a listed default model. */
const DISK_RUNTIME_DOCUMENT: SettingsDocument["runtime"] = Object.freeze({
  autoStartBackend: false,
  autoStartVmo: false,
  defaultModel: "on-disk",
  backendAddress: BACKEND_URL
})

/** The store's runtime group once {@link DISK_RUNTIME_DOCUMENT} is loaded. */
const DISK_RUNTIME_SETTINGS = Object.freeze({
  ...DISK_RUNTIME_DOCUMENT,
  defaultModel: Object.freeze({ provider: "lmStudio", modelKey: "on-disk" })
} satisfies RuntimeSettings)

/** Providers group on disk: only LM Studio on, so the default names its model. */
const DISK_PROVIDERS_SETTINGS = llmProviderSettingsSchema.parse({
  ...STORED_SETTINGS_DOCUMENT.providers,
  enabled: ["lmStudio"]
})

/** Settings document on disk with autostart off and a default model chosen. */
const DISK_SETTINGS_DOCUMENT: SettingsDocument = Object.freeze({
  ...STORED_SETTINGS_DOCUMENT,
  runtime: DISK_RUNTIME_DOCUMENT,
  providers: DISK_PROVIDERS_SETTINGS
})

/** The store's settings once {@link DISK_SETTINGS_DOCUMENT} is loaded. */
const DISK_SETTINGS: LysSettings = Object.freeze({
  ...STORED_SETTINGS,
  runtime: DISK_RUNTIME_SETTINGS,
  providers: DISK_PROVIDERS_SETTINGS
})

/** Runtime group on disk with backend autostart on. */
const BACKEND_AUTOSTART_RUNTIME_SETTINGS: SettingsDocument["runtime"] =
  Object.freeze({
    ...DISK_RUNTIME_DOCUMENT,
    autoStartBackend: true
  })

/** Settings document on disk with backend autostart on. */
const AUTOSTART_SETTINGS_DOCUMENT: SettingsDocument = Object.freeze({
  ...DISK_SETTINGS_DOCUMENT,
  runtime: BACKEND_AUTOSTART_RUNTIME_SETTINGS
})

/** Runtime group on disk with only vmo autostart on. */
const VMO_AUTOSTART_RUNTIME_SETTINGS: SettingsDocument["runtime"] =
  Object.freeze({
    ...DISK_RUNTIME_DOCUMENT,
    autoStartVmo: true
  })

/** Settings document on disk with only vmo autostart on. */
const VMO_AUTOSTART_SETTINGS_DOCUMENT: SettingsDocument = Object.freeze({
  ...DISK_SETTINGS_DOCUMENT,
  runtime: VMO_AUTOSTART_RUNTIME_SETTINGS
})

/** Runtime group on disk with backend and vmo autostart on. */
const BOTH_AUTOSTART_RUNTIME_SETTINGS: SettingsDocument["runtime"] =
  Object.freeze({
    ...DISK_RUNTIME_DOCUMENT,
    autoStartBackend: true,
    autoStartVmo: true
  })

/** Settings document on disk with backend and vmo autostart on. */
const BOTH_AUTOSTART_SETTINGS_DOCUMENT: SettingsDocument = Object.freeze({
  ...DISK_SETTINGS_DOCUMENT,
  runtime: BOTH_AUTOSTART_RUNTIME_SETTINGS
})

/** Generation controls a settings edit changes to. */
const EDITED_GENERATION_SETTINGS: GenerationSettings = Object.freeze({
  temperature: 0.9,
  replyCeiling: 0
})

/** Providers group a save changes to: LM Studio and Groq on, no address saved. */
const EDITED_PROVIDERS_SETTINGS = llmProviderSettingsSchema.parse({
  enabled: ["lmStudio", "groq"],
  lmStudio: { address: null },
  ollama: { address: null }
})

/** Location a save changes to: none, which removes the saved one. */
const NO_LOCATION_SETTINGS: LocationSettings = Object.freeze({
  city: null,
  region: null,
  country: null
})

/**
 * Settings document on disk once one edit of the four groups the store
 * saves by itself, the startup switches, generation, the per-model load
 * settings, and the tools, is saved, the Tavily key is removed,
 * {@link EDITED_PROVIDERS_SETTINGS} is chosen, the location and the added
 * MCP servers are removed, and the email account is removed with its
 * password: every group differs from {@link DISK_SETTINGS_DOCUMENT}.
 */
const EVERY_GROUP_EDITED_DOCUMENT: SettingsDocument = Object.freeze({
  runtime: VMO_AUTOSTART_RUNTIME_SETTINGS,
  generation: EDITED_GENERATION_SETTINGS,
  loadConfiguration: {
    default: DISK_SETTINGS_DOCUMENT.loadConfiguration.default,
    models: { "gemma-3": { evalBatchSize: 1024 } }
  },
  secrets: {
    ...DISK_SETTINGS_DOCUMENT.secrets,
    tavilyApiKey: null,
    emailPassword: null
  },
  providers: EDITED_PROVIDERS_SETTINGS,
  tools: { justRun: ["find_files"], switches: { web_search: true } },
  location: NO_LOCATION_SETTINGS,
  mcp: { ...DISK_SETTINGS_DOCUMENT.mcp, servers: [] },
  email: { account: null, lysAccount: null }
})

/** Inventory listed once LM Studio is connected. */
const INVENTORY = [
  buildLlmInfo("resident", { loaded: true }),
  buildLlmInfo("on-disk")
]

/** Route key of LM Studio's status read. */
const LM_STUDIO_STATUS_ROUTE = "GET /api/v1/llm/lmStudio/runtime"

/** Route key of LM Studio's inventory read. */
const LM_STUDIO_LIST_ROUTE = "GET /api/v1/llm/lmStudio/list"

/**
 * Backend that answers health, reports LM Studio connected and every other
 * provider off, and lists LM Studio's models.
 */
const CONNECTED_BACKEND: BackendRoutes = Object.freeze({
  "GET /api/v1/heath": () => buildJsonResponse(200, { status: "ok" }),
  ...buildProviderStatusRoutes({ lmStudio: "connected" }),
  [LM_STUDIO_LIST_ROUTE]: () =>
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

/** A native host whose settings file holds its writes until the case releases them. */
type SettingsFileHoldingWrites = Readonly<{
  /** Observation handle of the native host. */
  host: ReturnType<typeof startNativeHostFake>
  /** Lets every write, the pending ones and those that follow, complete. */
  releaseWrites: () => void
  /** Reads the document the settings file holds. */
  readStoredDocument: () => unknown
}>

/**
 * Starts a native host as {@link startDesktopHost} does, whose settings
 * commands keep one document as the settings file does: `load_settings`
 * returns the document last written, and each `save_settings` replaces it
 * once the case released the writes. Until then every write stays pending;
 * after that, each completes at once.
 *
 * @param settingsDocument - Document the file holds before the first write.
 * @returns The host observation handle, the release of the writes, and a
 * reader of the document the file holds.
 */
function startDesktopHostHoldingWrites(
  settingsDocument: SettingsDocument
): SettingsFileHoldingWrites {
  let storedDocument: unknown = settingsDocument
  const writeRelease = createControlledPromise<void>()

  /**
   * Handles one `save_settings` command as the settings file does, once the
   * case released the writes.
   *
   * @param args - Arguments the renderer invoked the command with.
   * @returns A promise resolving with the command's `null` result after the
   * document is replaced.
   * @throws A string, as a Rust `Err`, when the arguments carry no
   * `newSettings`.
   */
  async function handleSaveSettingsCommand(args: unknown): Promise<null> {
    if (!isSettingsWrite(args)) throw "save_settings needs newSettings"
    await writeRelease.promise
    storedDocument = args.newSettings
    return null
  }

  const host = startDesktopHost(settingsDocument, {
    load_settings: () => storedDocument,
    save_settings: handleSaveSettingsCommand
  })
  return {
    host,
    releaseWrites: () => writeRelease.resolve(),
    readStoredDocument: () => storedDocument
  }
}

/** Reason a failed spawn of the backend process rejects with. */
const SPAWN_FAILURE = "Failed to spawn the backend"

/** Reason a failed read of the backend process status rejects with. */
const STATUS_FAILURE = "Failed to inspect backend process: Resource busy"

/** Reason a failed stop of the backend process rejects with. */
const STOP_FAILURE =
  "Failed to terminate backend process group 4242: Operation not permitted"

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

/**
 * Native failures during a start, with the reason the start rejects with and
 * the status published after it: `stopped` once no process remains, and
 * `unresponsive` while one runs or its status cannot be read.
 */
const START_FAILURES = [
  [
    "the process cannot be spawned",
    startHostFailingSpawn,
    SPAWN_FAILURE,
    "stopped"
  ],
  [
    "the process status cannot be read while waiting for an answer",
    startHostFailingStatusAfterSpawn,
    STATUS_FAILURE,
    "unresponsive"
  ]
] as const

/**
 * Starts a running backend whose process then cannot be stopped.
 *
 * @param getStatusAfterStop - Answers the status read after the failed stop;
 * a process that still runs when omitted.
 * @returns The store, with the backend running.
 */
async function startBackendFailingStop(
  getStatusAfterStop: NativeCommand = () => ({ running: true })
) {
  startBackendFake(CONNECTED_BACKEND)
  let hasStopFailed = false
  startDesktopHost(DISK_SETTINGS_DOCUMENT, {
    get_backend_status: () =>
      hasStopFailed ? getStatusAfterStop({}) : { running: true },
    stop_backend: () => {
      hasStopFailed = true
      return Promise.reject(STOP_FAILURE)
    }
  })
  const useLysStore = await loadFreshLysStore()
  await useLysStore.getState().startBackend()
  return useLysStore
}

/**
 * Native outcomes of the status read after a failed stop, with the status
 * published after it.
 */
const STATUSES_AFTER_FAILED_STOP = [
  ["still runs", () => ({ running: true }), "unresponsive"],
  ["is gone", () => ({ running: false }), "stopped"],
  ["cannot be read", () => Promise.reject(STATUS_FAILURE), "unresponsive"]
] as const

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
      modelPaneSelection: null,
      modelPaneProvider: null,
      backendUrl: BACKEND_URL,
      initializing: true,
      backendServerInfo: { status: "stopped" },
      providerModels: INITIAL_PROVIDER_MODEL_STATES,
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
      groqApiKey: null,
      emailPassword: null,
      lysEmailPassword: null
    })
    expect(useLysStore.getState().settings.providers).toEqual({
      enabled: ["lmStudio"],
      lmStudio: { address: null },
      ollama: { address: null }
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

  it("selects the model the Models pane shows, and clears it", async () => {
    const useLysStore = await loadFreshLysStore()

    useLysStore
      .getState()
      .setModelPaneSelection({ provider: "groq", modelKey: "llama-3.3-70b" })
    expect(useLysStore.getState().modelPaneSelection).toEqual({
      provider: "groq",
      modelKey: "llama-3.3-70b"
    })

    useLysStore.getState().setModelPaneSelection(null)
    expect(useLysStore.getState().modelPaneSelection).toBeNull()
  })

  it("shows a provider the Models pane's picker chose with no model selected", async () => {
    const useLysStore = await loadFreshLysStore()
    useLysStore
      .getState()
      .setModelPaneSelection({ provider: "lmStudio", modelKey: "qwen3-8b" })

    useLysStore.getState().setModelPaneProvider("groq")

    expect(useLysStore.getState()).toMatchObject({
      modelPaneProvider: "groq",
      modelPaneSelection: null
    })
  })

  it("opens the settings view on the Models pane showing one model", async () => {
    const useLysStore = await loadFreshLysStore()
    const model = { provider: "lmStudio", modelKey: "qwen3-8b" } as const

    useLysStore.getState().showModelInSettings(model)

    expect(useLysStore.getState()).toMatchObject({
      activeView: "settings",
      settingsPane: "model",
      modelPaneSelection: model
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
    it("publishes running once the health route answers, then reads every provider and lists the connected one's models", async () => {
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
        }
      })
      expect(useLysStore.getState().providerModels).toMatchObject({
        lmStudio: {
          status: "connected",
          inventory: {
            status: "ready",
            modelLoading: "lys",
            models: INVENTORY
          }
        },
        ollama: { status: "off", inventory: { status: "unavailable" } },
        ollamaCloud: { status: "off", inventory: { status: "unavailable" } },
        groq: { status: "off", inventory: { status: "unavailable" } }
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

    it.each(START_FAILURES)(
      "publishes the status the process is in when %s, so Start or Stop is offered again",
      async (_failure, startHost, _reason, status) => {
        startHost()
        const useLysStore = await loadFreshLysStore()

        await Promise.allSettled([useLysStore.getState().startBackend()])

        expect(useLysStore.getState().backendServerInfo).toEqual({
          status,
          startedAt: undefined,
          stoppedAt: status === "stopped" ? expect.any(Date) : undefined
        })
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
    it("stops a running backend and releases every provider's status and models", async () => {
      startBackendFake(CONNECTED_BACKEND)
      const host = startDesktopHost(DISK_SETTINGS_DOCUMENT)
      const useLysStore = await loadFreshLysStore()
      await useLysStore.getState().startBackend()
      await waitForMicrotasks()

      await useLysStore.getState().stopBackend()

      expect(listCommandNames(host).at(-1)).toBe("stop_backend")
      expect(useLysStore.getState()).toMatchObject({
        backendServerInfo: { status: "stopped", stoppedAt: expect.any(Date) },
        providerModels: INITIAL_PROVIDER_MODEL_STATES
      })
    })

    it("rejects with the native reason when the process cannot be stopped", async () => {
      const useLysStore = await startBackendFailingStop()

      await expect(useLysStore.getState().stopBackend()).rejects.toBe(
        STOP_FAILURE
      )
    })

    it.each(STATUSES_AFTER_FAILED_STOP)(
      "publishes the status the process is in when it cannot be stopped and then %s, so Start or Stop is offered again",
      async (_outcome, getStatusAfterStop, status) => {
        const useLysStore = await startBackendFailingStop(getStatusAfterStop)

        await Promise.allSettled([useLysStore.getState().stopBackend()])

        expect(useLysStore.getState()).toMatchObject({
          backendServerInfo: {
            status,
            startedAt: expect.any(Date),
            stoppedAt: status === "stopped" ? expect.any(Date) : undefined
          },
          providerModels: INITIAL_PROVIDER_MODEL_STATES
        })
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
          approvedFolderPaths: [],
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
        runtime: { ...DISK_RUNTIME_DOCUMENT, autoStartVmo: true }
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

      const defaultModel = { provider: "groq", modelKey: "resident" } as const
      const runtime: RuntimeSettings = {
        ...DISK_RUNTIME_SETTINGS,
        defaultModel
      }
      useLysStore.getState().setSettings({ ...DISK_SETTINGS, runtime })
      await waitForMicrotasks()

      expect(useLysStore.getState().settings.runtime.defaultModel).toEqual(
        defaultModel
      )
      expect(listCommandNames(host)).not.toContain("save_settings")
    })
  })

  describe("settings group saves", () => {
    it("applies the saves of all nine settings groups one at a time, so the file keeps every group's change", async () => {
      /**
       * The store's settings once one edit changed the four groups the store
       * saves by itself: the startup switches, generation, the per-model load
       * settings, and the tools.
       */
      const autosavedGroupsEditedSettings: LysSettings = Object.freeze({
        ...DISK_SETTINGS,
        runtime: { ...DISK_RUNTIME_SETTINGS, autoStartVmo: true },
        generation: EDITED_GENERATION_SETTINGS,
        loadConfiguration: {
          default: DISK_SETTINGS.loadConfiguration.default,
          models: new Map([["gemma-3", { evalBatchSize: 1024 }]])
        },
        tools: {
          approvedFolderPaths: [],
          justRunToolNames: new Set(["find_files"]),
          switches: new Map([["web_search", true]])
        }
      })

      const file = startDesktopHostHoldingWrites(DISK_SETTINGS_DOCUMENT)
      const useLysStore = await loadFreshLysStore()
      await useLysStore.getState().initialize()
      const store = useLysStore.getState()
      const commandCountBeforeSaves = file.host.commands.length

      store.setSettings(autosavedGroupsEditedSettings)
      const outcomes = Promise.all([
        store.saveTavilyApiKey(null),
        store.saveProviderSettings("lmStudio", EDITED_PROVIDERS_SETTINGS),
        store.saveLocation(NO_LOCATION_SETTINGS),
        store.saveMcpServers([]),
        store.deleteEmailAccount("person", () =>
          store.saveEmailMailboxSwitch("person", false)
        )
      ])
      await waitForMicrotasks()
      const commandsDuringFirstWrite = listCommandNames(file.host).slice(
        commandCountBeforeSaves
      )
      file.releaseWrites()

      await expect(outcomes).resolves.toEqual([
        "saved",
        "saved",
        "saved",
        "saved",
        "saved"
      ])
      expect(commandsDuringFirstWrite).toEqual([
        "load_settings",
        "save_settings"
      ])
      expect(file.readStoredDocument()).toEqual(EVERY_GROUP_EDITED_DOCUMENT)
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

  describe("email account", () => {
    it("checks an account at the application store's current backend", async () => {
      /**
       * Answer of an email account check whose SMTP server refused the
       * password.
       */
      const refusedEmailCheck = checkEmailAccountApiResponseSchema.parse({
        status: "checked",
        imap: { status: "accepted" },
        smtp: { status: "failed", reason: "wrong-password" }
      })

      const backend = startBackendFake({
        "POST /api/v1/mcp/email/account-check": () =>
          buildJsonResponse(200, refusedEmailCheck)
      })
      const useLysStore = await loadFreshLysStore()
      useLysStore.setState({ backendUrl: FIXTURE_BACKEND_URL })

      const outcome = await useLysStore
        .getState()
        .saveEmailAccount("person", STORED_EMAIL_ACCOUNT, STORED_EMAIL_PASSWORD)

      expect(backend.requests.map((request) => request.url)).toEqual([
        `${FIXTURE_BACKEND_URL}/api/v1/mcp/email/account-check`
      ])
      expect(outcome).toBe("refused")
      expect(useLysStore.getState().emailAccountChecks.person).toEqual({
        status: "checked",
        outcome: refusedEmailCheck
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

  describe("provider and model coordination", () => {
    it("re-reads a provider's status after its model request fails, and releases its models once it is not reachable", async () => {
      let isConnected = true
      startBackendFake({
        ...CONNECTED_BACKEND,
        [LM_STUDIO_STATUS_ROUTE]: () =>
          buildJsonResponse(200, {
            status: isConnected ? "connected" : "unreachable"
          }),
        "POST /api/v1/llm/lmStudio/load": () =>
          Promise.reject(createTransportFailure())
      })
      startDesktopHost(DISK_SETTINGS_DOCUMENT)
      const useLysStore = await loadFreshLysStore()
      await useLysStore.getState().startBackend()
      await waitForMicrotasks()
      isConnected = false

      await useLysStore
        .getState()
        .loadModel({ provider: "lmStudio", modelKey: "on-disk" })

      expect(useLysStore.getState().providerModels.lmStudio).toMatchObject({
        status: "unreachable",
        inventory: { status: "unavailable" }
      })
    })

    it("lists every connected provider's models while another provider cannot be reached", async () => {
      const groqModels = [buildLlmInfo("llama-3.3-70b", { loaded: true })]
      startBackendFake({
        "GET /api/v1/heath": () => buildJsonResponse(200, { status: "ok" }),
        ...buildProviderStatusRoutes({
          lmStudio: "unreachable",
          groq: "connected"
        }),
        "GET /api/v1/llm/groq/list": () =>
          buildJsonResponse(200, { llms: groqModels, modelLoading: "provider" })
      })
      startDesktopHost({
        ...DISK_SETTINGS_DOCUMENT,
        providers: EDITED_PROVIDERS_SETTINGS
      })
      const useLysStore = await loadFreshLysStore()
      await useLysStore.getState().initialize()

      await useLysStore.getState().startBackend()
      await waitForMicrotasks()

      expect(useLysStore.getState().providerModels).toMatchObject({
        lmStudio: {
          status: "unreachable",
          inventory: { status: "unavailable" }
        },
        groq: {
          status: "connected",
          inventory: {
            status: "ready",
            modelLoading: "provider",
            models: groqModels
          }
        }
      })
    })

    it("releases a provider's models once the backend reports it off", async () => {
      let lmStudioStatus = "connected"
      startBackendFake({
        ...CONNECTED_BACKEND,
        [LM_STUDIO_STATUS_ROUTE]: () =>
          buildJsonResponse(200, { status: lmStudioStatus }),
        "POST /api/v1/llm/lmStudio/runtime/connect": () =>
          buildJsonResponse(200, { status: "off" })
      })
      startDesktopHost(DISK_SETTINGS_DOCUMENT)
      const useLysStore = await loadFreshLysStore()
      await useLysStore.getState().startBackend()
      await waitForMicrotasks()
      const listedBeforeOff =
        useLysStore.getState().providerModels.lmStudio.inventory.status
      lmStudioStatus = "off"

      await useLysStore.getState().connectProvider("lmStudio")

      expect(listedBeforeOff).toBe("ready")
      expect(useLysStore.getState().providerModels.lmStudio).toMatchObject({
        status: "off",
        inventory: { status: "unavailable" },
        loadedModelConfigurations: new Map()
      })
    })
  })
})
