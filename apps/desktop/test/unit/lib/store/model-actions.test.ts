import {
  createLlmRuntimeUnavailableProblem,
  createLlmServiceBusyProblem
} from "@lys/protocol"
import {
  LLM_PROVIDERS,
  modelLoadConfigurationSchema,
  type LlmModelReference,
  type LlmProvider
} from "@lys/share"
import { describe, expect, it } from "vitest"
import { createStore } from "zustand/vanilla"
import { createModelSlice, type ModelActions } from "@/lib/store/model-actions"
import {
  INITIAL_PROVIDER_MODEL_STATES,
  updateProviderModelState,
  type LlmProviderStatus,
  type ModelRequestState,
  type ProviderModelStates
} from "@/lib/store/model-runtime"
import type { ProviderModelsState } from "@/lib/store/provider-status"
import type { LoadConfigurationSettings } from "@/lib/store/settings"
import {
  buildJsonResponse,
  createTransportFailure,
  FIXTURE_BACKEND_URL,
  listRouteKeys,
  startBackendFake,
  type BackendFake,
  type BackendRoute,
  type BackendRoutes
} from "../../support/backendFake"
import { buildLlmInfo } from "../../support/modelFixtures"
import {
  createControlledPromise,
  createSettlementReader,
  waitForMicrotasks
} from "../../support/settlement"

/** Route keys of LM Studio's model endpoints. */
const LIST_ROUTE = "GET /api/v1/llm/lmStudio/list"
const LOAD_ROUTE = "POST /api/v1/llm/lmStudio/load"
const UNLOAD_ROUTE = "PATCH /api/v1/llm/lmStudio/unload"

/**
 * Names one of LM Studio's models.
 *
 * @param modelKey - Key of the model.
 * @returns The reference.
 */
function buildLmStudioModel(modelKey: string): LlmModelReference {
  return { provider: "lmStudio", modelKey }
}

/** Every provider connected, so each admits model requests. */
const CONNECTED_PROVIDER_MODELS: ProviderModelStates = LLM_PROVIDERS.reduce(
  (states, provider) =>
    updateProviderModelState(states, provider, { status: "connected" }),
  INITIAL_PROVIDER_MODEL_STATES
)

/** Inventory with one resident and one downloaded model. */
const INVENTORY = [
  buildLlmInfo("resident", { loaded: true }),
  buildLlmInfo("on-disk")
]

/** Inventory after `on-disk` was loaded. */
const INVENTORY_AFTER_LOAD = [
  buildLlmInfo("resident", { loaded: true }),
  buildLlmInfo("on-disk", { loaded: true })
]

/**
 * Stored default load settings. It sets every setting a load needs, each to a
 * value the committed default does not have, so every sent value shows which
 * stored part supplied it.
 */
const STORED_DEFAULT_LOAD_CONFIGURATION = modelLoadConfigurationSchema.parse({
  contextLength: 4096,
  evalBatchSize: 256,
  flashAttention: false,
  offloadKVCacheToGpu: false
})

/** Load settings `on-disk` has of its own; the stored default supplies the rest. */
const ON_DISK_OWN_LOAD_CONFIGURATION = modelLoadConfigurationSchema.parse({
  contextLength: 6144,
  flashAttention: true
})

/** Stored load settings in which only `on-disk` has settings of its own. */
const LOAD_CONFIGURATION_SETTINGS: LoadConfigurationSettings = Object.freeze({
  default: STORED_DEFAULT_LOAD_CONFIGURATION,
  models: new Map([["on-disk", ON_DISK_OWN_LOAD_CONFIGURATION]])
})

/** Stored load settings with the same default in which no model has its own. */
const DEFAULT_ONLY_LOAD_CONFIGURATION_SETTINGS: LoadConfigurationSettings =
  Object.freeze({
    default: STORED_DEFAULT_LOAD_CONFIGURATION,
    models: new Map()
  })

/** Configuration a model without settings of its own is loaded with. */
const RESOLVED_DEFAULT_CONFIGURATION = Object.freeze({
  contextLength: 4096,
  evalBatchSize: 256,
  flashAttention: false,
  offloadKVCacheToGpu: false
})

/**
 * Configuration `on-disk` is loaded with while the inventory does not list
 * it: its own context length and flash attention, the stored default's batch
 * size and KV cache placement.
 */
const RESOLVED_ON_DISK_CONFIGURATION = Object.freeze({
  contextLength: 6144,
  evalBatchSize: 256,
  flashAttention: true,
  offloadKVCacheToGpu: false
})

/**
 * Creates a store owning one model slice over a backend and stored load
 * settings the case controls, with every provider connected.
 *
 * @returns The store; a switch for whether the backend runs (it starts
 * running); a setter of one provider's status; the stored load settings the
 * slice reads (they start as {@link LOAD_CONFIGURATION_SETTINGS}; a case may
 * replace them); a reader of how many times the slice asked the store to
 * re-read a provider's status; and the providers it asked for, in order.
 */
function createModelStore() {
  const backend = { isBackendRunning: true }
  const storedSettings = { loadConfiguration: LOAD_CONFIGURATION_SETTINGS }
  const failedProviders: LlmProvider[] = []
  const store = createStore<ProviderModelsState & ModelActions>()(
    (set, get) => ({
      providerModels: CONNECTED_PROVIDER_MODELS,
      ...createModelSlice(set, get, {
        getBackendConnection: () => ({
          backendUrl: FIXTURE_BACKEND_URL,
          isBackendRunning: backend.isBackendRunning
        }),
        handleModelRequestFailure: async (provider) => {
          failedProviders.push(provider)
        },
        getLoadConfigurationSettings: () => storedSettings.loadConfiguration
      })
    })
  )

  /**
   * Publishes one provider's status, as the status slice would.
   *
   * @param provider - Provider whose status changes.
   * @param status - Its new status.
   */
  function updateStatus(provider: LlmProvider, status: LlmProviderStatus) {
    store.setState((state) => ({
      providerModels: updateProviderModelState(state.providerModels, provider, {
        status
      })
    }))
  }

  return {
    store,
    backend,
    updateStatus,
    storedSettings,
    failedProviders,
    getFailureReactionCount: () => failedProviders.length,
    getLmStudio: () => store.getState().providerModels.lmStudio
  }
}

/**
 * Builds a route answering the inventory list.
 *
 * @param models - Listed models.
 * @returns The route.
 */
function buildInventoryRoute(models: readonly unknown[]): BackendRoute {
  return () => buildJsonResponse(200, { llms: models, modelLoading: "lys" })
}

/**
 * Builds a route confirming that one model was loaded.
 *
 * @param modelKey - Key the backend reports as loaded.
 * @returns The route.
 */
function buildLoadRoute(modelKey: string): BackendRoute {
  return () => buildJsonResponse(200, buildLlmInfo(modelKey, { loaded: true }))
}

/**
 * Starts a backend with the given routes and returns the requests' route
 * keys in arrival order.
 *
 * @param routes - Routes the case expects.
 * @returns A reader of the route keys requested so far.
 */
function startModelBackend(routes: BackendRoutes): () => string[] {
  const backend = startBackendFake(routes)
  return () => listRouteKeys(backend)
}

/**
 * Lists the bodies of the load requests a backend double received.
 *
 * @param backend - Backend double the case started.
 * @returns Each load request's decoded body, in arrival order.
 */
function listLoadRequestBodies(backend: BackendFake): unknown[] {
  return backend.requests
    .filter((request) => request.routeKey === LOAD_ROUTE)
    .map((request) => request.body)
}

describe("createModelSlice", () => {
  it("leaves every provider with no observation and no request", () => {
    const { store } = createModelStore()

    for (const provider of LLM_PROVIDERS) {
      expect(store.getState().providerModels[provider]).toMatchObject({
        inventory: { status: "unavailable" },
        request: { status: "idle" },
        error: null,
        health: null,
        loadedModelConfigurations: new Map()
      })
    }
  })

  describe("updateModelInventory", () => {
    it("publishes the listing request, then the provider's inventory", async () => {
      startModelBackend({ [LIST_ROUTE]: buildInventoryRoute(INVENTORY) })
      const { store, getLmStudio } = createModelStore()

      const update = store.getState().updateModelInventory("lmStudio")
      const whileListing = getLmStudio().request
      await update

      expect(whileListing).toEqual({ status: "listing" })
      expect(getLmStudio()).toMatchObject({
        status: "connected",
        inventory: {
          status: "ready",
          modelLoading: "lys",
          models: INVENTORY
        },
        request: { status: "idle" },
        error: null
      })
      expect(store.getState().providerModels.groq.inventory).toEqual({
        status: "unavailable"
      })
    })

    it("assumes the stored configuration for each LM Studio model it finds already loaded", async () => {
      startModelBackend({ [LIST_ROUTE]: buildInventoryRoute(INVENTORY) })
      const { store, getLmStudio } = createModelStore()

      await store.getState().updateModelInventory("lmStudio")

      expect(getLmStudio().loadedModelConfigurations).toEqual(
        new Map([
          [
            "resident",
            { origin: "assumed", configuration: RESOLVED_DEFAULT_CONFIGURATION }
          ]
        ])
      )
    })

    it("records no load configuration for another provider's loaded models", async () => {
      startModelBackend({
        "GET /api/v1/llm/ollama/list": () =>
          buildJsonResponse(200, { llms: INVENTORY, modelLoading: "provider" })
      })
      const { store } = createModelStore()

      await store.getState().updateModelInventory("ollama")

      expect(store.getState().providerModels.ollama).toMatchObject({
        inventory: { status: "ready", modelLoading: "provider" },
        loadedModelConfigurations: new Map()
      })
    })

    it.each(["unknown", "connecting", "unreachable", "off"] as const)(
      "asks nothing while the provider is %s",
      async (status) => {
        const requests = startModelBackend({})
        const { store, updateStatus, getLmStudio } = createModelStore()
        updateStatus("lmStudio", status)

        await store.getState().updateModelInventory("lmStudio")

        expect(requests()).toEqual([])
        expect(getLmStudio().request).toEqual({ status: "idle" })
      }
    )

    it("asks nothing while the backend does not run", async () => {
      const requests = startModelBackend({})
      const { store, backend } = createModelStore()
      backend.isBackendRunning = false

      await store.getState().updateModelInventory("lmStudio")

      expect(requests()).toEqual([])
    })

    it("never publishes an answer that arrives after the provider became unreachable", async () => {
      const inventory = createControlledPromise<Response>()
      startModelBackend({ [LIST_ROUTE]: () => inventory.promise })
      const { store, updateStatus, getLmStudio } = createModelStore()
      const update = store.getState().updateModelInventory("lmStudio")
      await waitForMicrotasks()

      updateStatus("lmStudio", "unreachable")
      inventory.resolve(
        buildJsonResponse(200, { llms: INVENTORY, modelLoading: "lys" })
      )
      await update

      expect(getLmStudio().inventory).toEqual({ status: "unavailable" })
    })

    it("admits one request at a time per provider", async () => {
      const inventory = createControlledPromise<Response>()
      const requests = startModelBackend({
        [LIST_ROUTE]: () => inventory.promise
      })
      const { store } = createModelStore()
      const first = store.getState().updateModelInventory("lmStudio")

      await store.getState().loadModel(buildLmStudioModel("on-disk"))
      inventory.resolve(
        buildJsonResponse(200, { llms: INVENTORY, modelLoading: "lys" })
      )
      await first

      expect(requests()).toEqual([LIST_ROUTE])
    })

    it("lists another provider while one provider's list is still pending", async () => {
      const slow = createControlledPromise<Response>()
      const groqModels = [buildLlmInfo("llama-3.3-70b", { loaded: true })]
      startModelBackend({
        [LIST_ROUTE]: () => slow.promise,
        "GET /api/v1/llm/groq/list": () =>
          buildJsonResponse(200, { llms: groqModels, modelLoading: "provider" })
      })
      const { store, getLmStudio } = createModelStore()
      const lmStudioList = store.getState().updateModelInventory("lmStudio")
      await waitForMicrotasks()

      await store.getState().updateModelInventory("groq")
      const groqWhileLmStudioPending =
        store.getState().providerModels.groq.inventory
      const lmStudioRequest = getLmStudio().request
      slow.resolve(
        buildJsonResponse(200, { llms: INVENTORY, modelLoading: "lys" })
      )
      await lmStudioList

      expect(groqWhileLmStudioPending).toEqual({
        status: "ready",
        modelLoading: "provider",
        models: groqModels
      })
      expect(lmStudioRequest).toEqual({ status: "listing" })
      expect(getLmStudio().inventory).toMatchObject({ models: INVENTORY })
    })

    it("keeps one provider's failure to that provider", async () => {
      startModelBackend({
        [LIST_ROUTE]: () => buildJsonResponse(500, { detail: "boom" }),
        "GET /api/v1/llm/groq/list": () =>
          buildJsonResponse(200, { llms: [], modelLoading: "provider" })
      })
      const { store, failedProviders } = createModelStore()

      await Promise.all([
        store.getState().updateModelInventory("lmStudio"),
        store.getState().updateModelInventory("groq")
      ])

      expect(store.getState().providerModels.lmStudio).toMatchObject({
        inventory: { status: "failed" },
        error: expect.stringContaining("500")
      })
      expect(store.getState().providerModels.groq).toMatchObject({
        inventory: { status: "ready" },
        error: null
      })
      expect(failedProviders).toEqual(["lmStudio"])
    })

    it("shows a failed observation with its reason, then re-reads the provider's status", async () => {
      startModelBackend({
        [LIST_ROUTE]: () => buildJsonResponse(500, { detail: "boom" })
      })
      const { store, getFailureReactionCount, getLmStudio } = createModelStore()

      await store.getState().updateModelInventory("lmStudio")

      expect(getLmStudio()).toMatchObject({
        inventory: { status: "failed" },
        error: expect.stringContaining("500")
      })
      expect(getFailureReactionCount()).toBe(1)
    })

    it("leaves a missing runtime to the provider's status instead of showing a model error", async () => {
      startModelBackend({
        [LIST_ROUTE]: () =>
          buildJsonResponse(
            503,
            createLlmRuntimeUnavailableProblem("LM Studio is not connected.")
          )
      })
      const { store, getFailureReactionCount, getLmStudio } = createModelStore()

      await store.getState().updateModelInventory("lmStudio")

      expect(getLmStudio()).toMatchObject({
        inventory: { status: "unavailable" },
        error: null
      })
      expect(getFailureReactionCount()).toBe(1)
    })
  })

  describe("loadModel", () => {
    it("publishes the loading transition, loads, then reconciles the inventory", async () => {
      const requests = startModelBackend({
        [LOAD_ROUTE]: () =>
          buildJsonResponse(200, buildLlmInfo("on-disk", { loaded: true })),
        [LIST_ROUTE]: buildInventoryRoute(INVENTORY_AFTER_LOAD)
      })
      const { store, getFailureReactionCount, getLmStudio } = createModelStore()

      const load = store.getState().loadModel(buildLmStudioModel("on-disk"))
      const whileLoading = getLmStudio().request
      await load

      expect(whileLoading).toEqual({ status: "loading", modelKey: "on-disk" })
      expect(requests()).toEqual([LOAD_ROUTE, LIST_ROUTE])
      expect(getLmStudio()).toMatchObject({
        inventory: {
          status: "ready",
          modelLoading: "lys",
          models: INVENTORY_AFTER_LOAD
        },
        request: { status: "idle" },
        error: null
      })
      expect(getFailureReactionCount()).toBe(0)
    })

    it("sends the load to the provider the reference names", async () => {
      const requests = startModelBackend({
        "POST /api/v1/llm/ollama/load": () =>
          buildJsonResponse(200, buildLlmInfo("mistral", { loaded: true })),
        "GET /api/v1/llm/ollama/list": () =>
          buildJsonResponse(200, {
            llms: [buildLlmInfo("mistral", { loaded: true })],
            modelLoading: "lys"
          })
      })
      const { store } = createModelStore()

      await store
        .getState()
        .loadModel({ provider: "ollama", modelKey: "mistral" })

      expect(requests()).toEqual([
        "POST /api/v1/llm/ollama/load",
        "GET /api/v1/llm/ollama/list"
      ])
      expect(store.getState().providerModels.ollama.inventory).toMatchObject({
        status: "ready"
      })
      expect(store.getState().providerModels.lmStudio.inventory).toEqual({
        status: "unavailable"
      })
    })

    it("shows a refused load and still reconciles the inventory", async () => {
      const busy = createLlmServiceBusyProblem()
      const requests = startModelBackend({
        [LOAD_ROUTE]: () => buildJsonResponse(503, busy),
        [LIST_ROUTE]: buildInventoryRoute(INVENTORY)
      })
      const { store, getFailureReactionCount, getLmStudio } = createModelStore()

      await store.getState().loadModel(buildLmStudioModel("on-disk"))

      expect(requests()).toEqual([LOAD_ROUTE, LIST_ROUTE])
      expect(getLmStudio()).toMatchObject({
        inventory: {
          status: "ready",
          modelLoading: "lys",
          models: INVENTORY
        },
        error: busy.detail
      })
      expect(getFailureReactionCount()).toBe(1)
    })

    it("names both failures when the reconciling read also fails", async () => {
      const busy = createLlmServiceBusyProblem()
      startModelBackend({
        [LOAD_ROUTE]: () => buildJsonResponse(503, busy),
        [LIST_ROUTE]: () => buildJsonResponse(500, {})
      })
      const { store, getLmStudio } = createModelStore()

      await store.getState().loadModel(buildLmStudioModel("on-disk"))

      expect(getLmStudio().error).toMatch(
        new RegExp(`^${busy.detail} Inventory refresh also failed: .*500`)
      )
    })

    it("never retries a load", async () => {
      const requests = startModelBackend({
        [LOAD_ROUTE]: () => Promise.reject(createTransportFailure()),
        [LIST_ROUTE]: buildInventoryRoute(INVENTORY)
      })
      const { store } = createModelStore()

      await store.getState().loadModel(buildLmStudioModel("on-disk"))

      expect(requests().filter((route) => route === LOAD_ROUTE)).toHaveLength(1)
    })

    it("sends the model's own load settings, completed by the stored default", async () => {
      const backend = startBackendFake({
        [LOAD_ROUTE]: buildLoadRoute("on-disk"),
        [LIST_ROUTE]: buildInventoryRoute(INVENTORY_AFTER_LOAD)
      })
      const { store } = createModelStore()

      await store.getState().loadModel(buildLmStudioModel("on-disk"))

      expect(listLoadRequestBodies(backend)).toEqual([
        { modelId: "on-disk", configuration: RESOLVED_ON_DISK_CONFIGURATION }
      ])
    })

    it("sends the stored default for a model without settings of its own", async () => {
      const backend = startBackendFake({
        [LOAD_ROUTE]: buildLoadRoute("on-disk"),
        [LIST_ROUTE]: buildInventoryRoute(INVENTORY_AFTER_LOAD)
      })
      const { store, storedSettings } = createModelStore()
      storedSettings.loadConfiguration =
        DEFAULT_ONLY_LOAD_CONFIGURATION_SETTINGS

      await store.getState().loadModel(buildLmStudioModel("on-disk"))

      expect(listLoadRequestBodies(backend)).toEqual([
        { modelId: "on-disk", configuration: RESOLVED_DEFAULT_CONFIGURATION }
      ])
    })

    it("caps the sent context length at the maximum the inventory lists for the model", async () => {
      const backend = startBackendFake({
        [LIST_ROUTE]: buildInventoryRoute([
          buildLlmInfo("on-disk", { maxContextLength: 5000 })
        ]),
        [LOAD_ROUTE]: buildLoadRoute("on-disk")
      })
      const { store } = createModelStore()
      await store.getState().updateModelInventory("lmStudio")

      await store.getState().loadModel(buildLmStudioModel("on-disk"))

      expect(listLoadRequestBodies(backend)).toEqual([
        {
          modelId: "on-disk",
          configuration: {
            ...RESOLVED_ON_DISK_CONFIGURATION,
            contextLength: 5000
          }
        }
      ])
    })

    it("remembers the configuration it sent while the model is loaded", async () => {
      startModelBackend({
        [LOAD_ROUTE]: buildLoadRoute("on-disk"),
        [LIST_ROUTE]: buildInventoryRoute(INVENTORY_AFTER_LOAD)
      })
      const { store, getLmStudio } = createModelStore()

      await store.getState().loadModel(buildLmStudioModel("on-disk"))

      expect(getLmStudio().loadedModelConfigurations.get("on-disk")).toEqual({
        origin: "sent",
        configuration: RESOLVED_ON_DISK_CONFIGURATION
      })
    })
  })

  describe("updateLoadedModelConfiguration", () => {
    it("publishes unloading, then loading, while it unloads and loads the model again", async () => {
      const requests = startModelBackend({
        [UNLOAD_ROUTE]: () => new Response(null, { status: 204 }),
        [LOAD_ROUTE]: buildLoadRoute("resident"),
        [LIST_ROUTE]: buildInventoryRoute(INVENTORY)
      })
      const { store, getLmStudio } = createModelStore()
      const publishedRequests: ModelRequestState[] = []
      store.subscribe((state) => {
        publishedRequests.push(state.providerModels.lmStudio.request)
      })

      await store
        .getState()
        .updateLoadedModelConfiguration(buildLmStudioModel("resident"))

      expect(requests()).toEqual([UNLOAD_ROUTE, LOAD_ROUTE, LIST_ROUTE])
      expect(publishedRequests).toEqual([
        { status: "unloading", modelKey: "resident" },
        { status: "loading", modelKey: "resident" },
        { status: "idle" }
      ])
      expect(getLmStudio()).toMatchObject({
        inventory: { status: "ready", models: INVENTORY },
        error: null
      })
    })

    it("loads the model with its stored configuration and remembers it as sent", async () => {
      const backend = startBackendFake({
        [UNLOAD_ROUTE]: () => new Response(null, { status: 204 }),
        [LOAD_ROUTE]: buildLoadRoute("resident"),
        [LIST_ROUTE]: buildInventoryRoute(INVENTORY)
      })
      const { store, getLmStudio } = createModelStore()

      await store
        .getState()
        .updateLoadedModelConfiguration(buildLmStudioModel("resident"))

      expect(listLoadRequestBodies(backend)).toEqual([
        { modelId: "resident", configuration: RESOLVED_DEFAULT_CONFIGURATION }
      ])
      expect(getLmStudio().loadedModelConfigurations.get("resident")).toEqual({
        origin: "sent",
        configuration: RESOLVED_DEFAULT_CONFIGURATION
      })
    })

    it("sends the configuration stored at admission, not one edited during the unload", async () => {
      const unload = createControlledPromise<Response>()
      const backend = startBackendFake({
        [UNLOAD_ROUTE]: () => unload.promise,
        [LOAD_ROUTE]: buildLoadRoute("resident"),
        [LIST_ROUTE]: buildInventoryRoute(INVENTORY)
      })
      const { store, storedSettings } = createModelStore()
      const editedSettings: LoadConfigurationSettings = {
        default: STORED_DEFAULT_LOAD_CONFIGURATION,
        models: new Map([
          [
            "resident",
            modelLoadConfigurationSchema.parse({ contextLength: 2048 })
          ]
        ])
      }
      const reload = store
        .getState()
        .updateLoadedModelConfiguration(buildLmStudioModel("resident"))

      storedSettings.loadConfiguration = editedSettings
      unload.resolve(new Response(null, { status: 204 }))
      await reload

      expect(listLoadRequestBodies(backend)).toEqual([
        { modelId: "resident", configuration: RESOLVED_DEFAULT_CONFIGURATION }
      ])
    })

    it("starts no load when the unload fails", async () => {
      const requests = startModelBackend({
        [UNLOAD_ROUTE]: () => buildJsonResponse(500, {}),
        [LIST_ROUTE]: buildInventoryRoute(INVENTORY)
      })
      const { store, getFailureReactionCount, getLmStudio } = createModelStore()

      await store
        .getState()
        .updateLoadedModelConfiguration(buildLmStudioModel("resident"))

      expect(requests()).toEqual([UNLOAD_ROUTE, LIST_ROUTE])
      expect(getLmStudio()).toMatchObject({
        inventory: { status: "ready", models: INVENTORY },
        error: expect.stringContaining("500")
      })
      expect(getFailureReactionCount()).toBe(1)
    })

    it("leaves the model unloaded and shows the failure when the load after the unload fails", async () => {
      const busy = createLlmServiceBusyProblem()
      const unloadedInventory = [
        buildLlmInfo("resident"),
        buildLlmInfo("on-disk")
      ]
      const requests = startModelBackend({
        [UNLOAD_ROUTE]: () => new Response(null, { status: 204 }),
        [LOAD_ROUTE]: () => buildJsonResponse(503, busy),
        [LIST_ROUTE]: buildInventoryRoute(unloadedInventory)
      })
      const { store, getFailureReactionCount, getLmStudio } = createModelStore()

      await store
        .getState()
        .updateLoadedModelConfiguration(buildLmStudioModel("resident"))

      expect(requests()).toEqual([UNLOAD_ROUTE, LOAD_ROUTE, LIST_ROUTE])
      expect(getLmStudio()).toMatchObject({
        inventory: { status: "ready", models: unloadedInventory },
        request: { status: "idle" },
        error: busy.detail
      })
      expect(getFailureReactionCount()).toBe(1)
    })
  })

  describe("unloadModel", () => {
    it("publishes the unloading transition, unloads, then reconciles the inventory", async () => {
      const unloadedInventory = [buildLlmInfo("resident")]
      const requests = startModelBackend({
        [UNLOAD_ROUTE]: () => new Response(null, { status: 204 }),
        [LIST_ROUTE]: buildInventoryRoute(unloadedInventory)
      })
      const { store, getLmStudio } = createModelStore()

      const unload = store
        .getState()
        .unloadModel(buildLmStudioModel("resident"))
      const whileUnloading = getLmStudio().request
      await unload

      expect(whileUnloading).toEqual({
        status: "unloading",
        modelKey: "resident"
      })
      expect(requests()).toEqual([UNLOAD_ROUTE, LIST_ROUTE])
      expect(getLmStudio().inventory).toMatchObject({
        models: unloadedInventory
      })
    })

    it("reconciles the inventory after a failed unload", async () => {
      const requests = startModelBackend({
        [UNLOAD_ROUTE]: () => buildJsonResponse(500, {}),
        [LIST_ROUTE]: buildInventoryRoute(INVENTORY)
      })
      const { store, getLmStudio } = createModelStore()

      await store.getState().unloadModel(buildLmStudioModel("resident"))

      expect(requests()).toEqual([UNLOAD_ROUTE, LIST_ROUTE])
      expect(getLmStudio()).toMatchObject({
        inventory: { status: "ready", models: INVENTORY },
        error: expect.stringContaining("500")
      })
    })
  })

  describe("testModel", () => {
    it("publishes the health observation without a status re-read", async () => {
      const health = { modelId: "resident", status: "ready", latencyMs: 7 }
      startModelBackend({
        "GET /api/v1/llm/lmStudio/resident/health": () =>
          buildJsonResponse(200, health),
        [LIST_ROUTE]: buildInventoryRoute(INVENTORY)
      })
      const { store, getFailureReactionCount, getLmStudio } = createModelStore()

      await store.getState().testModel(buildLmStudioModel("resident"))

      expect(getLmStudio().health).toEqual(health)
      expect(getFailureReactionCount()).toBe(0)
    })

    it.each([
      ["runtime-unavailable", 1],
      ["model-not-loaded", 0]
    ])(
      "re-reads the provider's status after a not-ready %s observation: %s time(s)",
      async (reason, reactions) => {
        startModelBackend({
          "GET /api/v1/llm/lmStudio/resident/health": () =>
            buildJsonResponse(200, {
              modelId: "resident",
              status: "not-ready",
              reason,
              latencyMs: 2
            }),
          [LIST_ROUTE]: buildInventoryRoute(INVENTORY)
        })
        const { store, getFailureReactionCount } = createModelStore()

        await store.getState().testModel(buildLmStudioModel("resident"))

        expect(getFailureReactionCount()).toBe(reactions)
      }
    )

    it("clears the previous observation when the next request starts", async () => {
      startModelBackend({
        "GET /api/v1/llm/lmStudio/resident/health": () =>
          buildJsonResponse(200, {
            modelId: "resident",
            status: "ready",
            latencyMs: 7
          }),
        [LIST_ROUTE]: buildInventoryRoute(INVENTORY)
      })
      const { store, getLmStudio } = createModelStore()
      await store.getState().testModel(buildLmStudioModel("resident"))

      const update = store.getState().updateModelInventory("lmStudio")
      const whileListing = getLmStudio().health
      await update

      expect(whileListing).toBeNull()
    })
  })

  describe("handleModelRequestFailure", () => {
    it("is awaited before a failed request resolves", async () => {
      startModelBackend({ [LIST_ROUTE]: () => buildJsonResponse(500, {}) })
      const reaction = createControlledPromise<void>()
      const store = createStore<ProviderModelsState & ModelActions>()(
        (set, get) => ({
          providerModels: CONNECTED_PROVIDER_MODELS,
          ...createModelSlice(set, get, {
            getBackendConnection: () => ({
              backendUrl: FIXTURE_BACKEND_URL,
              isBackendRunning: true
            }),
            handleModelRequestFailure: () => reaction.promise,
            getLoadConfigurationSettings: () => LOAD_CONFIGURATION_SETTINGS
          })
        })
      )

      const getSettlement = createSettlementReader(
        store.getState().updateModelInventory("lmStudio")
      )
      await waitForMicrotasks()
      const beforeReaction = getSettlement()
      reaction.resolve()
      await waitForMicrotasks()

      expect([beforeReaction, getSettlement()]).toEqual([
        "pending",
        "fulfilled"
      ])
    })
  })

  describe("releaseProviderModels", () => {
    it("returns the provider to its released state, aborts its request, and never publishes its late result", async () => {
      const inventory = createControlledPromise<Response>()
      const backend = startBackendFake({
        [LIST_ROUTE]: () => inventory.promise
      })
      const { store, getLmStudio } = createModelStore()
      const update = store.getState().updateModelInventory("lmStudio")
      await waitForMicrotasks()

      store.getState().releaseProviderModels("lmStudio")
      inventory.resolve(
        buildJsonResponse(200, { llms: INVENTORY, modelLoading: "lys" })
      )
      await update

      expect(backend.requests[0]?.signal?.aborted).toBe(true)
      expect(getLmStudio()).toMatchObject({
        status: "connected",
        inventory: { status: "unavailable" },
        request: { status: "idle" }
      })
    })

    it("leaves every other provider's state and request alone", async () => {
      const groqList = createControlledPromise<Response>()
      const groqModels = [buildLlmInfo("llama-3.3-70b", { loaded: true })]
      const backend = startBackendFake({
        [LIST_ROUTE]: buildInventoryRoute(INVENTORY),
        "GET /api/v1/llm/groq/list": () => groqList.promise
      })
      const { store, getLmStudio } = createModelStore()
      await store.getState().updateModelInventory("lmStudio")
      const groqUpdate = store.getState().updateModelInventory("groq")
      await waitForMicrotasks()

      store.getState().releaseProviderModels("lmStudio")
      groqList.resolve(
        buildJsonResponse(200, { llms: groqModels, modelLoading: "provider" })
      )
      await groqUpdate

      expect(getLmStudio().inventory).toEqual({ status: "unavailable" })
      expect(backend.requests[1]?.signal?.aborted).toBe(false)
      expect(store.getState().providerModels.groq.inventory).toEqual({
        status: "ready",
        modelLoading: "provider",
        models: groqModels
      })
    })

    it("sends nothing more of a reload it interrupts during the unload", async () => {
      const unload = createControlledPromise<Response>()
      const requests = startModelBackend({
        [UNLOAD_ROUTE]: () => unload.promise
      })
      const { store, getLmStudio } = createModelStore()
      const reload = store
        .getState()
        .updateLoadedModelConfiguration(buildLmStudioModel("resident"))
      await waitForMicrotasks()

      store.getState().releaseProviderModels("lmStudio")
      unload.resolve(new Response(null, { status: 204 }))
      await reload
      await waitForMicrotasks()

      expect(requests()).toEqual([UNLOAD_ROUTE])
      expect(getLmStudio()).toMatchObject({
        request: { status: "idle" },
        inventory: { status: "unavailable" },
        error: null
      })
    })

    it("forgets the configurations of the loaded models", async () => {
      startModelBackend({ [LIST_ROUTE]: buildInventoryRoute(INVENTORY) })
      const { store, getLmStudio } = createModelStore()
      await store.getState().updateModelInventory("lmStudio")
      const recordsBeforeRelease = getLmStudio().loadedModelConfigurations.size

      store.getState().releaseProviderModels("lmStudio")

      expect([
        recordsBeforeRelease,
        getLmStudio().loadedModelConfigurations.size
      ]).toEqual([1, 0])
    })

    it("admits a new request after release", async () => {
      const first = createControlledPromise<Response>()
      let listCount = 0
      startBackendFake({
        [LIST_ROUTE]: () => {
          listCount += 1
          return listCount === 1
            ? first.promise
            : buildJsonResponse(200, { llms: INVENTORY, modelLoading: "lys" })
        }
      })
      const { store, getLmStudio } = createModelStore()
      void store.getState().updateModelInventory("lmStudio")
      await waitForMicrotasks()
      store.getState().releaseProviderModels("lmStudio")

      await store.getState().updateModelInventory("lmStudio")

      expect(getLmStudio().inventory).toEqual({
        status: "ready",
        modelLoading: "lys",
        models: INVENTORY
      })
    })
  })
})
