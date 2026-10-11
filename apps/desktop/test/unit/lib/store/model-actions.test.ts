import {
  createLlmRuntimeUnavailableProblem,
  createLlmServiceBusyProblem
} from "@lys/protocol"
import { modelLoadConfigurationSchema } from "@lys/share"
import { describe, expect, it } from "vitest"
import { createStore } from "zustand/vanilla"
import {
  createModelSlice,
  type ModelConnectionState,
  type ModelSlice
} from "@/lib/store/model-actions"
import type { ModelRequestState } from "@/lib/store/model-runtime"
import type { LoadConfigurationSettings } from "@/lib/store/settings"
import {
  buildJsonResponse,
  createTransportFailure,
  startBackendFake,
  type BackendFake,
  type BackendRoute,
  type BackendRoutes,
  type ObservedBackendRequest
} from "../../support/backendFake"
import { buildLlmInfo } from "../../support/modelFixtures"
import {
  createControlledPromise,
  createSettlementReader,
  waitForMicrotasks
} from "../../support/settlement"

/** Backend origin the store reports; it differs from the production default. */
const BACKEND_URL = "http://backend.test:4100"

/** Route keys of the model endpoints. */
const LIST_ROUTE = "GET /api/v1/llm/list"
const LOAD_ROUTE = "POST /api/v1/llm/load"
const UNLOAD_ROUTE = "PATCH /api/v1/llm/unload"

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
 * Creates a store owning one model slice over a connection and stored load
 * settings the case controls.
 *
 * @param defaultModel - Default model the summary prefers.
 * @returns The store, a switch for whether the model runtime is available
 * (it starts available), the stored load settings the slice reads (they
 * start as {@link LOAD_CONFIGURATION_SETTINGS}; a case may replace them), and
 * a reader of how many times the slice asked the store to re-read the LM
 * Studio status.
 */
function createModelStore(defaultModel: string | null = null) {
  const connection = { isModelRuntimeAvailable: true }
  const storedSettings = { loadConfiguration: LOAD_CONFIGURATION_SETTINGS }
  let failureReactions = 0
  const store = createStore<ModelSlice>()((set, get) =>
    createModelSlice(set, get, {
      getConnection: (): ModelConnectionState => ({
        backendUrl: BACKEND_URL,
        isModelRuntimeAvailable: connection.isModelRuntimeAvailable,
        defaultModel
      }),
      handleModelRequestFailure: async () => {
        failureReactions += 1
      },
      getLoadConfigurationSettings: () => storedSettings.loadConfiguration
    })
  )
  return {
    store,
    connection,
    storedSettings,
    getFailureReactionCount: () => failureReactions
  }
}

/**
 * Builds a route answering the inventory list.
 *
 * @param models - Listed models.
 * @returns The route.
 */
function buildInventoryRoute(models: readonly unknown[]): BackendRoute {
  return () => buildJsonResponse(200, { llms: models })
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
 * Builds the route key of one received request.
 *
 * @param request - Request the backend double received.
 * @returns The `"<METHOD> <path>"` key the routes are declared under.
 */
function buildRouteKey(request: ObservedBackendRequest): string {
  return `${request.method} ${new URL(request.url).pathname}`
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
  return () => backend.requests.map(buildRouteKey)
}

/**
 * Lists the bodies of the load requests a backend double received.
 *
 * @param backend - Backend double the case started.
 * @returns Each load request's decoded body, in arrival order.
 */
function listLoadRequestBodies(backend: BackendFake): unknown[] {
  return backend.requests
    .filter((request) => buildRouteKey(request) === LOAD_ROUTE)
    .map((request) => request.body)
}

describe("createModelSlice", () => {
  it("starts with no observation and no request", () => {
    expect(createModelStore().store.getState()).toMatchObject({
      modelInventory: { status: "unavailable" },
      modelRequest: { status: "idle" },
      modelRuntime: { status: "none" },
      modelError: null,
      modelHealth: null,
      loadedModelConfigurations: new Map()
    })
  })

  describe("updateModelInventory", () => {
    it("publishes the listing request, then the inventory and the preferred resident model", async () => {
      startModelBackend({ [LIST_ROUTE]: buildInventoryRoute(INVENTORY) })
      const { store } = createModelStore()

      const update = store.getState().updateModelInventory()
      const whileListing = store.getState().modelRequest
      await update

      expect(whileListing).toEqual({ status: "listing" })
      expect(store.getState()).toMatchObject({
        modelInventory: { status: "ready", models: INVENTORY },
        modelRequest: { status: "idle" },
        modelRuntime: { status: "loaded", modelKey: "resident" },
        modelError: null
      })
    })

    it("assumes the stored configuration for each model it finds already loaded", async () => {
      startModelBackend({ [LIST_ROUTE]: buildInventoryRoute(INVENTORY) })
      const { store } = createModelStore()

      await store.getState().updateModelInventory()

      expect(store.getState().loadedModelConfigurations).toEqual(
        new Map([
          [
            "resident",
            { origin: "assumed", configuration: RESOLVED_DEFAULT_CONFIGURATION }
          ]
        ])
      )
    })

    it("asks nothing while the model runtime is unavailable", async () => {
      const requests = startModelBackend({})
      const { store, connection } = createModelStore()
      connection.isModelRuntimeAvailable = false

      await store.getState().updateModelInventory()

      expect(requests()).toEqual([])
      expect(store.getState().modelRequest).toEqual({ status: "idle" })
    })

    it("admits one request at a time", async () => {
      const inventory = createControlledPromise<Response>()
      const requests = startModelBackend({
        [LIST_ROUTE]: () => inventory.promise
      })
      const { store } = createModelStore()
      const first = store.getState().updateModelInventory()

      await store.getState().loadModel("on-disk")
      inventory.resolve(buildJsonResponse(200, { llms: INVENTORY }))
      await first

      expect(requests()).toEqual([LIST_ROUTE])
    })

    it("shows a failed observation as unknown residency with its reason, then re-reads the LM Studio status", async () => {
      startModelBackend({
        [LIST_ROUTE]: () => buildJsonResponse(500, { detail: "boom" })
      })
      const { store, getFailureReactionCount } = createModelStore()

      await store.getState().updateModelInventory()

      expect(store.getState()).toMatchObject({
        modelInventory: { status: "failed" },
        modelRuntime: { status: "unknown" },
        modelError: expect.stringContaining("500")
      })
      expect(getFailureReactionCount()).toBe(1)
    })

    it("leaves a missing runtime to the LM Studio status instead of showing a model error", async () => {
      startModelBackend({
        [LIST_ROUTE]: () =>
          buildJsonResponse(
            503,
            createLlmRuntimeUnavailableProblem("LM Studio is not connected.")
          )
      })
      const { store, getFailureReactionCount } = createModelStore()

      await store.getState().updateModelInventory()

      expect(store.getState()).toMatchObject({
        modelInventory: { status: "unavailable" },
        modelRuntime: { status: "none" },
        modelError: null
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
      const { store, getFailureReactionCount } = createModelStore("on-disk")

      const load = store.getState().loadModel("on-disk")
      const whileLoading = store.getState().modelRuntime
      await load

      expect(whileLoading).toEqual({ status: "loading", modelKey: "on-disk" })
      expect(requests()).toEqual([LOAD_ROUTE, LIST_ROUTE])
      expect(store.getState()).toMatchObject({
        modelInventory: { status: "ready", models: INVENTORY_AFTER_LOAD },
        modelRuntime: { status: "loaded", modelKey: "on-disk" },
        modelRequest: { status: "idle" },
        modelError: null
      })
      expect(getFailureReactionCount()).toBe(0)
    })

    it("shows a refused load and still reconciles the inventory", async () => {
      const busy = createLlmServiceBusyProblem()
      const requests = startModelBackend({
        [LOAD_ROUTE]: () => buildJsonResponse(503, busy),
        [LIST_ROUTE]: buildInventoryRoute(INVENTORY)
      })
      const { store, getFailureReactionCount } = createModelStore()

      await store.getState().loadModel("on-disk")

      expect(requests()).toEqual([LOAD_ROUTE, LIST_ROUTE])
      expect(store.getState()).toMatchObject({
        modelInventory: { status: "ready", models: INVENTORY },
        modelError: busy.detail
      })
      expect(getFailureReactionCount()).toBe(1)
    })

    it("names both failures when the reconciling read also fails", async () => {
      const busy = createLlmServiceBusyProblem()
      startModelBackend({
        [LOAD_ROUTE]: () => buildJsonResponse(503, busy),
        [LIST_ROUTE]: () => buildJsonResponse(500, {})
      })
      const { store } = createModelStore()

      await store.getState().loadModel("on-disk")

      expect(store.getState().modelError).toMatch(
        new RegExp(`^${busy.detail} Inventory refresh also failed: .*500`)
      )
    })

    it("never retries a load", async () => {
      const requests = startModelBackend({
        [LOAD_ROUTE]: () => Promise.reject(createTransportFailure()),
        [LIST_ROUTE]: buildInventoryRoute(INVENTORY)
      })
      const { store } = createModelStore()

      await store.getState().loadModel("on-disk")

      expect(requests().filter((route) => route === LOAD_ROUTE)).toHaveLength(1)
    })

    it("sends the model's own load settings, completed by the stored default", async () => {
      const backend = startBackendFake({
        [LOAD_ROUTE]: buildLoadRoute("on-disk"),
        [LIST_ROUTE]: buildInventoryRoute(INVENTORY_AFTER_LOAD)
      })
      const { store } = createModelStore()

      await store.getState().loadModel("on-disk")

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

      await store.getState().loadModel("on-disk")

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
      await store.getState().updateModelInventory()

      await store.getState().loadModel("on-disk")

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
      const { store } = createModelStore()

      await store.getState().loadModel("on-disk")

      expect(store.getState().loadedModelConfigurations.get("on-disk")).toEqual(
        { origin: "sent", configuration: RESOLVED_ON_DISK_CONFIGURATION }
      )
    })
  })

  describe("updateLoadedModelConfiguration", () => {
    it("publishes unloading, then loading, while it unloads and loads the model again", async () => {
      const requests = startModelBackend({
        [UNLOAD_ROUTE]: () => new Response(null, { status: 204 }),
        [LOAD_ROUTE]: buildLoadRoute("resident"),
        [LIST_ROUTE]: buildInventoryRoute(INVENTORY)
      })
      const { store } = createModelStore()
      const publishedRequests: ModelRequestState[] = []
      store.subscribe((state) => {
        publishedRequests.push(state.modelRequest)
      })

      await store.getState().updateLoadedModelConfiguration("resident")

      expect(requests()).toEqual([UNLOAD_ROUTE, LOAD_ROUTE, LIST_ROUTE])
      expect(publishedRequests).toEqual([
        { status: "unloading", modelKey: "resident" },
        { status: "loading", modelKey: "resident" },
        { status: "idle" }
      ])
      expect(store.getState()).toMatchObject({
        modelRuntime: { status: "loaded", modelKey: "resident" },
        modelError: null
      })
    })

    it("loads the model with its stored configuration and remembers it as sent", async () => {
      const backend = startBackendFake({
        [UNLOAD_ROUTE]: () => new Response(null, { status: 204 }),
        [LOAD_ROUTE]: buildLoadRoute("resident"),
        [LIST_ROUTE]: buildInventoryRoute(INVENTORY)
      })
      const { store } = createModelStore()

      await store.getState().updateLoadedModelConfiguration("resident")

      expect(listLoadRequestBodies(backend)).toEqual([
        { modelId: "resident", configuration: RESOLVED_DEFAULT_CONFIGURATION }
      ])
      expect(
        store.getState().loadedModelConfigurations.get("resident")
      ).toEqual({
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
      const reload = store.getState().updateLoadedModelConfiguration("resident")

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
      const { store, getFailureReactionCount } = createModelStore()

      await store.getState().updateLoadedModelConfiguration("resident")

      expect(requests()).toEqual([UNLOAD_ROUTE, LIST_ROUTE])
      expect(store.getState()).toMatchObject({
        modelRuntime: { status: "loaded", modelKey: "resident" },
        modelError: expect.stringContaining("500")
      })
      expect(getFailureReactionCount()).toBe(1)
    })

    it("leaves the model unloaded and shows the failure when the load after the unload fails", async () => {
      const busy = createLlmServiceBusyProblem()
      const requests = startModelBackend({
        [UNLOAD_ROUTE]: () => new Response(null, { status: 204 }),
        [LOAD_ROUTE]: () => buildJsonResponse(503, busy),
        [LIST_ROUTE]: buildInventoryRoute([
          buildLlmInfo("resident"),
          buildLlmInfo("on-disk")
        ])
      })
      const { store, getFailureReactionCount } = createModelStore()

      await store.getState().updateLoadedModelConfiguration("resident")

      expect(requests()).toEqual([UNLOAD_ROUTE, LOAD_ROUTE, LIST_ROUTE])
      expect(store.getState()).toMatchObject({
        modelRuntime: { status: "none" },
        modelRequest: { status: "idle" },
        modelError: busy.detail
      })
      expect(getFailureReactionCount()).toBe(1)
    })
  })

  describe("unloadModel", () => {
    it("publishes the unloading transition, unloads, then reconciles the inventory", async () => {
      const requests = startModelBackend({
        [UNLOAD_ROUTE]: () => new Response(null, { status: 204 }),
        [LIST_ROUTE]: buildInventoryRoute([buildLlmInfo("resident")])
      })
      const { store } = createModelStore()

      const unload = store.getState().unloadModel("resident")
      const whileUnloading = store.getState().modelRuntime
      await unload

      expect(whileUnloading).toEqual({
        status: "unloading",
        modelKey: "resident"
      })
      expect(requests()).toEqual([UNLOAD_ROUTE, LIST_ROUTE])
      expect(store.getState().modelRuntime).toEqual({ status: "none" })
    })

    it("reconciles the inventory after a failed unload", async () => {
      const requests = startModelBackend({
        [UNLOAD_ROUTE]: () => buildJsonResponse(500, {}),
        [LIST_ROUTE]: buildInventoryRoute(INVENTORY)
      })
      const { store } = createModelStore()

      await store.getState().unloadModel("resident")

      expect(requests()).toEqual([UNLOAD_ROUTE, LIST_ROUTE])
      expect(store.getState()).toMatchObject({
        modelRuntime: { status: "loaded", modelKey: "resident" },
        modelError: expect.stringContaining("500")
      })
    })
  })

  describe("testModel", () => {
    it("publishes the health observation without a status re-read", async () => {
      const health = { modelId: "resident", status: "ready", latencyMs: 7 }
      startModelBackend({
        "GET /api/v1/llm/resident/health": () => buildJsonResponse(200, health),
        [LIST_ROUTE]: buildInventoryRoute(INVENTORY)
      })
      const { store, getFailureReactionCount } = createModelStore()

      await store.getState().testModel("resident")

      expect(store.getState().modelHealth).toEqual(health)
      expect(getFailureReactionCount()).toBe(0)
    })

    it.each([
      ["runtime-unavailable", 1],
      ["model-not-loaded", 0]
    ])(
      "re-reads the LM Studio status after a not-ready %s observation: %s time(s)",
      async (reason, reactions) => {
        startModelBackend({
          "GET /api/v1/llm/resident/health": () =>
            buildJsonResponse(200, {
              modelId: "resident",
              status: "not-ready",
              reason,
              latencyMs: 2
            }),
          [LIST_ROUTE]: buildInventoryRoute(INVENTORY)
        })
        const { store, getFailureReactionCount } = createModelStore()

        await store.getState().testModel("resident")

        expect(getFailureReactionCount()).toBe(reactions)
      }
    )

    it("clears the previous observation when the next request starts", async () => {
      startModelBackend({
        "GET /api/v1/llm/resident/health": () =>
          buildJsonResponse(200, {
            modelId: "resident",
            status: "ready",
            latencyMs: 7
          }),
        [LIST_ROUTE]: buildInventoryRoute(INVENTORY)
      })
      const { store } = createModelStore()
      await store.getState().testModel("resident")

      const update = store.getState().updateModelInventory()
      const whileListing = store.getState().modelHealth
      await update

      expect(whileListing).toBeNull()
    })
  })

  describe("handleModelRequestFailure", () => {
    it("is awaited before a failed request resolves", async () => {
      startModelBackend({ [LIST_ROUTE]: () => buildJsonResponse(500, {}) })
      const reaction = createControlledPromise<void>()
      const store = createStore<ModelSlice>()((set, get) =>
        createModelSlice(set, get, {
          getConnection: () => ({
            backendUrl: BACKEND_URL,
            isModelRuntimeAvailable: true,
            defaultModel: null
          }),
          handleModelRequestFailure: () => reaction.promise,
          getLoadConfigurationSettings: () => LOAD_CONFIGURATION_SETTINGS
        })
      )

      const getSettlement = createSettlementReader(
        store.getState().updateModelInventory()
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

  describe("releaseModelRuntime", () => {
    it("returns to the initial state, aborts the request, and never publishes its late result", async () => {
      const inventory = createControlledPromise<Response>()
      const backend = startBackendFake({
        [LIST_ROUTE]: () => inventory.promise
      })
      const { store } = createModelStore()
      const update = store.getState().updateModelInventory()
      await waitForMicrotasks()

      store.getState().releaseModelRuntime()
      inventory.resolve(buildJsonResponse(200, { llms: INVENTORY }))
      await update

      expect(backend.requests[0]?.signal?.aborted).toBe(true)
      expect(store.getState()).toMatchObject({
        modelInventory: { status: "unavailable" },
        modelRequest: { status: "idle" },
        modelRuntime: { status: "none" }
      })
    })

    it("forgets the configurations of the loaded models", async () => {
      startModelBackend({ [LIST_ROUTE]: buildInventoryRoute(INVENTORY) })
      const { store } = createModelStore()
      await store.getState().updateModelInventory()
      const recordsBeforeRelease =
        store.getState().loadedModelConfigurations.size

      store.getState().releaseModelRuntime()

      expect([
        recordsBeforeRelease,
        store.getState().loadedModelConfigurations.size
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
            : buildJsonResponse(200, { llms: INVENTORY })
        }
      })
      const { store } = createModelStore()
      void store.getState().updateModelInventory()
      await waitForMicrotasks()
      store.getState().releaseModelRuntime()

      await store.getState().updateModelInventory()

      expect(store.getState().modelInventory).toEqual({
        status: "ready",
        models: INVENTORY
      })
    })
  })
})
