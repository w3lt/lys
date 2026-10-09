import {
  createLlmRuntimeUnavailableProblem,
  createLlmServiceBusyProblem
} from "@lys/protocol"
import { describe, expect, it } from "vitest"
import { createStore } from "zustand/vanilla"
import {
  createModelSlice,
  type ModelConnectionState,
  type ModelSlice
} from "@/lib/store/model-actions"
import {
  buildJsonResponse,
  startBackendFake,
  type BackendRoute,
  type BackendRoutes
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
 * Creates a store owning one model slice over a connection the case controls.
 *
 * @param defaultModel - Default model the summary prefers.
 * @returns The store, a switch for whether the model runtime is available
 * (it starts available), and a reader of how many times the slice asked the
 * store to re-read the LM Studio status.
 */
function createModelStore(defaultModel: string | null = null) {
  const connection = { isModelRuntimeAvailable: true }
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
      }
    })
  )
  return { store, connection, countFailureReactions: () => failureReactions }
}

/**
 * Builds a route answering the inventory list.
 *
 * @param models - Listed models.
 * @returns The route.
 */
function answerInventory(models: readonly unknown[]): BackendRoute {
  return () => buildJsonResponse(200, { llms: models })
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
  return () =>
    backend.requests.map(
      (request) => `${request.method} ${new URL(request.url).pathname}`
    )
}

describe("createModelSlice", () => {
  it("starts with no observation and no request", () => {
    expect(createModelStore().store.getState()).toMatchObject({
      modelInventory: { status: "unavailable" },
      modelRequest: { status: "idle" },
      modelRuntime: { status: "none" },
      modelError: null,
      modelHealth: null
    })
  })

  describe("updateModelInventory", () => {
    it("publishes the listing request, then the inventory and the preferred resident model", async () => {
      startModelBackend({ [LIST_ROUTE]: answerInventory(INVENTORY) })
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
      const { store, countFailureReactions } = createModelStore()

      await store.getState().updateModelInventory()

      expect(store.getState()).toMatchObject({
        modelInventory: { status: "failed" },
        modelRuntime: { status: "unknown" },
        modelError: expect.stringContaining("500")
      })
      expect(countFailureReactions()).toBe(1)
    })

    it("leaves a missing runtime to the LM Studio status instead of showing a model error", async () => {
      startModelBackend({
        [LIST_ROUTE]: () =>
          buildJsonResponse(
            503,
            createLlmRuntimeUnavailableProblem("LM Studio is not connected.")
          )
      })
      const { store, countFailureReactions } = createModelStore()

      await store.getState().updateModelInventory()

      expect(store.getState()).toMatchObject({
        modelInventory: { status: "unavailable" },
        modelRuntime: { status: "none" },
        modelError: null
      })
      expect(countFailureReactions()).toBe(1)
    })
  })

  describe("loadModel", () => {
    it("publishes the loading transition, loads, then reconciles the inventory", async () => {
      const requests = startModelBackend({
        [LOAD_ROUTE]: () =>
          buildJsonResponse(200, buildLlmInfo("on-disk", { loaded: true })),
        [LIST_ROUTE]: answerInventory(INVENTORY_AFTER_LOAD)
      })
      const { store, countFailureReactions } = createModelStore("on-disk")

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
      expect(countFailureReactions()).toBe(0)
    })

    it("shows a refused load and still reconciles the inventory", async () => {
      const busy = createLlmServiceBusyProblem()
      const requests = startModelBackend({
        [LOAD_ROUTE]: () => buildJsonResponse(503, busy),
        [LIST_ROUTE]: answerInventory(INVENTORY)
      })
      const { store, countFailureReactions } = createModelStore()

      await store.getState().loadModel("on-disk")

      expect(requests()).toEqual([LOAD_ROUTE, LIST_ROUTE])
      expect(store.getState()).toMatchObject({
        modelInventory: { status: "ready", models: INVENTORY },
        modelError: busy.detail
      })
      expect(countFailureReactions()).toBe(1)
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
        [LOAD_ROUTE]: () => Promise.reject(new TypeError("fetch failed")),
        [LIST_ROUTE]: answerInventory(INVENTORY)
      })
      const { store } = createModelStore()

      await store.getState().loadModel("on-disk")

      expect(requests().filter((route) => route === LOAD_ROUTE)).toHaveLength(1)
    })
  })

  describe("unloadModel", () => {
    it("publishes the unloading transition, unloads, then reconciles the inventory", async () => {
      const requests = startModelBackend({
        [UNLOAD_ROUTE]: () => new Response(null, { status: 204 }),
        [LIST_ROUTE]: answerInventory([buildLlmInfo("resident")])
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
        [LIST_ROUTE]: answerInventory(INVENTORY)
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
        [LIST_ROUTE]: answerInventory(INVENTORY)
      })
      const { store, countFailureReactions } = createModelStore()

      await store.getState().testModel("resident")

      expect(store.getState().modelHealth).toEqual(health)
      expect(countFailureReactions()).toBe(0)
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
          [LIST_ROUTE]: answerInventory(INVENTORY)
        })
        const { store, countFailureReactions } = createModelStore()

        await store.getState().testModel("resident")

        expect(countFailureReactions()).toBe(reactions)
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
        [LIST_ROUTE]: answerInventory(INVENTORY)
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
          handleModelRequestFailure: () => reaction.promise
        })
      )

      const readSettlement = createSettlementReader(
        store.getState().updateModelInventory()
      )
      await waitForMicrotasks()
      const beforeReaction = readSettlement()
      reaction.resolve()
      await waitForMicrotasks()

      expect([beforeReaction, readSettlement()]).toEqual([
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
