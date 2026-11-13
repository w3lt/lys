import { createLlmServiceBusyProblem } from "@lys/protocol"
import { LLM_PROVIDERS, type LlmProvider } from "@lys/share"
import { describe, expect, it } from "vitest"
import { createStore } from "zustand/vanilla"
import {
  INITIAL_PROVIDER_MODEL_STATES,
  type LlmProviderStatus
} from "@/lib/store/model-runtime"
import {
  createProviderStatusSlice,
  type ProviderModelsState,
  type ProviderStatusActions
} from "@/lib/store/provider-status"
import {
  buildJsonResponse,
  createControlledRoute,
  createTransportFailure,
  FIXTURE_BACKEND_URL,
  startBackendFake,
  type BackendRoute
} from "../../support/backendFake"
import {
  createSettlementReader,
  waitForMicrotasks
} from "../../support/settlement"

/**
 * Builds the route key of one provider's status read.
 *
 * @param provider - Provider the read is for.
 * @returns The route key.
 */
function buildStatusRoute(provider: LlmProvider): string {
  return `GET /api/v1/llm/${provider}/runtime`
}

/**
 * Builds the route key of one provider's connect request.
 *
 * @param provider - Provider the request is for.
 * @returns The route key.
 */
function buildConnectRoute(provider: LlmProvider): string {
  return `POST /api/v1/llm/${provider}/runtime/connect`
}

/** Route key of LM Studio's status read. */
const STATUS_ROUTE = buildStatusRoute("lmStudio")

/** Route key of LM Studio's connect request. */
const CONNECT_ROUTE = buildConnectRoute("lmStudio")

/** One published status change: the provider and its new status. */
type StatusChange = readonly [LlmProvider, LlmProviderStatus]

/**
 * Creates a store owning one provider status slice over a backend the case
 * controls.
 *
 * @returns The store, the published status changes in order, and a switch
 * for whether the backend runs; it starts running.
 */
function createStatusStore() {
  const backend = { isBackendRunning: true }
  const changes: StatusChange[] = []
  const store = createStore<ProviderModelsState & ProviderStatusActions>()(
    (set, get) => ({
      providerModels: INITIAL_PROVIDER_MODEL_STATES,
      ...createProviderStatusSlice(set, get, {
        getBackendConnection: () => ({
          backendUrl: FIXTURE_BACKEND_URL,
          isBackendRunning: backend.isBackendRunning
        }),
        handleProviderStatusChange: (provider, status) => {
          changes.push([provider, status])
        }
      })
    })
  )
  return { store, changes, backend }
}

/**
 * Builds a route answering with one runtime connection status.
 *
 * @param status - Status the backend reports.
 * @returns The route.
 */
function buildStatusAnswer(status: string): BackendRoute {
  return () => buildJsonResponse(200, { status })
}

describe("createProviderStatusSlice", () => {
  it("leaves every provider's status unknown at first", () => {
    const { store } = createStatusStore()

    for (const provider of LLM_PROVIDERS) {
      expect(store.getState().providerModels[provider].status).toBe("unknown")
    }
  })

  describe("updateProviderStatus", () => {
    it("publishes the status the backend reports for the provider and notifies the change once", async () => {
      const backend = startBackendFake({
        [buildStatusRoute("groq")]: buildStatusAnswer("connected")
      })
      const { store, changes } = createStatusStore()

      await store.getState().updateProviderStatus("groq")
      await store.getState().updateProviderStatus("groq")

      expect(store.getState().providerModels.groq.status).toBe("connected")
      expect(store.getState().providerModels.lmStudio.status).toBe("unknown")
      expect(changes).toEqual([["groq", "connected"]])
      expect(backend.requests[0]?.url).toBe(
        `${FIXTURE_BACKEND_URL}/api/v1/llm/groq/runtime`
      )
    })

    it("publishes off for a provider the backend reports off", async () => {
      startBackendFake({ [STATUS_ROUTE]: buildStatusAnswer("off") })
      const { store, changes } = createStatusStore()

      await store.getState().updateProviderStatus("lmStudio")

      expect(changes).toEqual([["lmStudio", "off"]])
    })

    it("follows a connecting status with the backend's settled attempt", async () => {
      startBackendFake({
        [STATUS_ROUTE]: buildStatusAnswer("connecting"),
        [CONNECT_ROUTE]: buildStatusAnswer("unreachable")
      })
      const { store, changes } = createStatusStore()

      await store.getState().updateProviderStatus("lmStudio")

      expect(changes).toEqual([
        ["lmStudio", "connecting"],
        ["lmStudio", "unreachable"]
      ])
    })

    it("publishes unknown when the status cannot be read", async () => {
      let isReachable = true
      startBackendFake({
        [STATUS_ROUTE]: () =>
          isReachable
            ? buildJsonResponse(200, { status: "connected" })
            : Promise.reject(createTransportFailure())
      })
      const { store, changes } = createStatusStore()
      await store.getState().updateProviderStatus("lmStudio")
      isReachable = false

      await expect(
        store.getState().updateProviderStatus("lmStudio")
      ).resolves.toBeUndefined()

      expect(changes).toEqual([
        ["lmStudio", "connected"],
        ["lmStudio", "unknown"]
      ])
    })

    it("asks nothing while the backend does not run", async () => {
      const backend = startBackendFake({})
      const { store, backend: owner } = createStatusStore()
      owner.isBackendRunning = false

      await store.getState().updateProviderStatus("lmStudio")

      expect(backend.requests).toEqual([])
      expect(store.getState().providerModels.lmStudio.status).toBe("unknown")
    })

    it("publishes only the latest of overlapping reads of one provider and abandons the older one", async () => {
      startBackendFake({ [STATUS_ROUTE]: buildStatusAnswer("connected") })
      const { store, changes } = createStatusStore()
      await store.getState().updateProviderStatus("lmStudio")
      const status = createControlledRoute()
      const backend = startBackendFake({ [STATUS_ROUTE]: status.route })
      const older = store.getState().updateProviderStatus("lmStudio")
      const newer = store.getState().updateProviderStatus("lmStudio")
      await waitForMicrotasks()

      status.responses[1]?.resolve(
        buildJsonResponse(200, { status: "unreachable" })
      )
      await Promise.all([older, newer])

      expect(changes).toEqual([
        ["lmStudio", "connected"],
        ["lmStudio", "unreachable"]
      ])
      expect(backend.requests[0]?.signal?.aborted).toBe(true)
    })

    it("does not abandon one provider's read for another's", async () => {
      const lmStudio = createControlledRoute()
      const backend = startBackendFake({
        [STATUS_ROUTE]: lmStudio.route,
        [buildStatusRoute("groq")]: buildStatusAnswer("connected")
      })
      const { store, changes } = createStatusStore()
      const lmStudioRead = store.getState().updateProviderStatus("lmStudio")
      await waitForMicrotasks()

      await store.getState().updateProviderStatus("groq")
      lmStudio.responses[0]?.resolve(
        buildJsonResponse(200, { status: "unreachable" })
      )
      await lmStudioRead

      expect(changes).toEqual([
        ["groq", "connected"],
        ["lmStudio", "unreachable"]
      ])
      expect(backend.requests[0]?.signal?.aborted).toBe(false)
    })

    it("does not publish a status that arrives after the backend stopped", async () => {
      const status = createControlledRoute()
      startBackendFake({ [STATUS_ROUTE]: status.route })
      const { store, changes, backend } = createStatusStore()
      const update = store.getState().updateProviderStatus("lmStudio")
      await waitForMicrotasks()

      backend.isBackendRunning = false
      status.responses[0]?.resolve(
        buildJsonResponse(200, { status: "connected" })
      )
      await update

      expect(changes).toEqual([])
      expect(store.getState().providerModels.lmStudio.status).toBe("unknown")
    })
  })

  describe("updateProviderStatuses", () => {
    it("reads every provider at once, so a slow one does not hold back the others", async () => {
      const slow = createControlledRoute()
      startBackendFake({
        [STATUS_ROUTE]: slow.route,
        [buildStatusRoute("ollama")]: buildStatusAnswer("off"),
        [buildStatusRoute("ollamaCloud")]: buildStatusAnswer("off"),
        [buildStatusRoute("groq")]: buildStatusAnswer("connected")
      })
      const { store, changes } = createStatusStore()

      const update = store.getState().updateProviderStatuses()
      await waitForMicrotasks()
      const beforeSlowAnswer = [...changes]
      slow.responses[0]?.resolve(
        buildJsonResponse(200, { status: "connected" })
      )
      await update

      expect(beforeSlowAnswer).toEqual(
        expect.arrayContaining([
          ["ollama", "off"],
          ["ollamaCloud", "off"],
          ["groq", "connected"]
        ])
      )
      expect(beforeSlowAnswer).not.toContainEqual(["lmStudio", "connected"])
      expect(store.getState().providerModels.lmStudio.status).toBe("connected")
    })
  })

  describe("connectProvider", () => {
    it("publishes connecting at once, then the settled status", async () => {
      const connect = createControlledRoute()
      startBackendFake({ [CONNECT_ROUTE]: connect.route })
      const { store, changes } = createStatusStore()

      const connection = store.getState().connectProvider("lmStudio")
      const whilePending = store.getState().providerModels.lmStudio.status
      await waitForMicrotasks()
      connect.responses[0]?.resolve(
        buildJsonResponse(200, { status: "connected" })
      )
      await connection

      expect(whilePending).toBe("connecting")
      expect(changes).toEqual([
        ["lmStudio", "connecting"],
        ["lmStudio", "connected"]
      ])
    })

    it("connects only the provider it names", async () => {
      const backend = startBackendFake({
        [buildConnectRoute("ollamaCloud")]: buildStatusAnswer("unreachable")
      })
      const { store, changes } = createStatusStore()

      await store.getState().connectProvider("ollamaCloud")

      expect(backend.requests).toHaveLength(1)
      expect(changes).toEqual([
        ["ollamaCloud", "connecting"],
        ["ollamaCloud", "unreachable"]
      ])
    })

    it("publishes unknown when the backend refuses the attempt", async () => {
      startBackendFake({
        [CONNECT_ROUTE]: () =>
          buildJsonResponse(503, createLlmServiceBusyProblem())
      })
      const { store, changes } = createStatusStore()

      await expect(
        store.getState().connectProvider("lmStudio")
      ).resolves.toBeUndefined()

      expect(changes).toEqual([
        ["lmStudio", "connecting"],
        ["lmStudio", "unknown"]
      ])
    })

    it("does nothing while the backend does not run", async () => {
      const backend = startBackendFake({})
      const { store, changes, backend: owner } = createStatusStore()
      owner.isBackendRunning = false

      await store.getState().connectProvider("lmStudio")

      expect(backend.requests).toEqual([])
      expect(changes).toEqual([])
    })
  })

  describe("resetProviderStatuses", () => {
    it("publishes unknown and never publishes an abandoned request's answer", async () => {
      startBackendFake({ [STATUS_ROUTE]: buildStatusAnswer("connected") })
      const pending = createControlledRoute()
      const { store, changes } = createStatusStore()
      await store.getState().updateProviderStatus("lmStudio")
      startBackendFake({ [STATUS_ROUTE]: pending.route })
      const getSettlement = createSettlementReader(
        store.getState().updateProviderStatus("lmStudio")
      )
      await waitForMicrotasks()

      store.getState().resetProviderStatuses()
      pending.responses[0]?.resolve(
        buildJsonResponse(200, { status: "unreachable" })
      )
      await waitForMicrotasks()

      expect(changes).toEqual([
        ["lmStudio", "connected"],
        ["lmStudio", "unknown"]
      ])
      expect(getSettlement()).toBe("fulfilled")
    })

    it("notifies only the providers whose status was known", async () => {
      startBackendFake({
        [buildStatusRoute("groq")]: buildStatusAnswer("connected")
      })
      const { store, changes } = createStatusStore()
      await store.getState().updateProviderStatus("groq")

      store.getState().resetProviderStatuses()

      expect(changes).toEqual([
        ["groq", "connected"],
        ["groq", "unknown"]
      ])
    })
  })
})
