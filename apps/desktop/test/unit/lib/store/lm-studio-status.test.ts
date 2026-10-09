import { createLlmServiceBusyProblem } from "@lys/protocol"
import { describe, expect, it } from "vitest"
import { createStore } from "zustand/vanilla"
import {
  createLmStudioStatusSlice,
  type LmStudioStatus,
  type LmStudioStatusSlice
} from "@/lib/store/lm-studio-status"
import {
  buildJsonResponse,
  startBackendFake,
  type BackendRoute
} from "../../support/backendFake"
import {
  createControlledPromise,
  createSettlementReader,
  waitForMicrotasks,
  type ControlledPromise
} from "../../support/settlement"

/** Backend origin the store reports; it differs from the production default. */
const BACKEND_URL = "http://backend.test:4100"

/** Route key of the status read. */
const STATUS_ROUTE = "GET /api/v1/llm/runtime"

/** Route key of the connect request. */
const CONNECT_ROUTE = "POST /api/v1/llm/runtime/connect"

/**
 * Creates a store owning one LM Studio status slice over a backend the case
 * controls.
 *
 * @returns The store, the published status changes in order, and a switch
 * for whether the backend runs; it starts running.
 */
function createStatusStore() {
  const backend = { isBackendRunning: true }
  const changes: LmStudioStatus[] = []
  const store = createStore<LmStudioStatusSlice>()((set, get) =>
    createLmStudioStatusSlice(set, get, {
      getBackendConnection: () => ({
        backendUrl: BACKEND_URL,
        isBackendRunning: backend.isBackendRunning
      }),
      handleLmStudioStatusChange: (status) => {
        changes.push(status)
      }
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
function answerStatus(status: string): BackendRoute {
  return () => buildJsonResponse(200, { status })
}

/**
 * Builds a route whose responses stay pending until the case settles them.
 *
 * @returns The route and the pending responses in arrival order.
 */
function createControlledRoute() {
  const responses: ControlledPromise<Response>[] = []
  const route: BackendRoute = () => {
    const response = createControlledPromise<Response>()
    responses.push(response)
    return response.promise
  }
  return { route, responses }
}

describe("createLmStudioStatusSlice", () => {
  it("starts with an unknown status", () => {
    expect(createStatusStore().store.getState().lmStudioStatus).toBe("unknown")
  })

  describe("updateLmStudioStatus", () => {
    it("publishes the status the backend reports and notifies the change once", async () => {
      const backend = startBackendFake({
        [STATUS_ROUTE]: answerStatus("connected")
      })
      const { store, changes } = createStatusStore()

      await store.getState().updateLmStudioStatus()
      await store.getState().updateLmStudioStatus()

      expect(store.getState().lmStudioStatus).toBe("connected")
      expect(changes).toEqual(["connected"])
      expect(backend.requests[0]?.url).toBe(`${BACKEND_URL}/api/v1/llm/runtime`)
    })

    it("follows a connecting status with the backend's settled attempt", async () => {
      startBackendFake({
        [STATUS_ROUTE]: answerStatus("connecting"),
        [CONNECT_ROUTE]: answerStatus("unreachable")
      })
      const { store, changes } = createStatusStore()

      await store.getState().updateLmStudioStatus()

      expect(changes).toEqual(["connecting", "unreachable"])
    })

    it("publishes unknown when the status cannot be read", async () => {
      let isReachable = true
      startBackendFake({
        [STATUS_ROUTE]: () =>
          isReachable
            ? buildJsonResponse(200, { status: "connected" })
            : Promise.reject(new TypeError("fetch failed"))
      })
      const { store, changes } = createStatusStore()
      await store.getState().updateLmStudioStatus()
      isReachable = false

      await expect(
        store.getState().updateLmStudioStatus()
      ).resolves.toBeUndefined()

      expect(changes).toEqual(["connected", "unknown"])
    })

    it("asks nothing while the backend does not run", async () => {
      const backend = startBackendFake({})
      const { store, backend: owner } = createStatusStore()
      owner.isBackendRunning = false

      await store.getState().updateLmStudioStatus()

      expect(backend.requests).toEqual([])
      expect(store.getState().lmStudioStatus).toBe("unknown")
    })

    it("publishes only the latest of overlapping reads and abandons the older one", async () => {
      startBackendFake({ [STATUS_ROUTE]: answerStatus("connected") })
      const { store, changes } = createStatusStore()
      await store.getState().updateLmStudioStatus()
      const status = createControlledRoute()
      const backend = startBackendFake({ [STATUS_ROUTE]: status.route })
      const older = store.getState().updateLmStudioStatus()
      const newer = store.getState().updateLmStudioStatus()
      await waitForMicrotasks()

      status.responses[1]?.resolve(
        buildJsonResponse(200, { status: "unreachable" })
      )
      await Promise.all([older, newer])

      expect(changes).toEqual(["connected", "unreachable"])
      expect(backend.requests[0]?.signal?.aborted).toBe(true)
    })

    it("does not publish a status that arrives after the backend stopped", async () => {
      const status = createControlledRoute()
      startBackendFake({ [STATUS_ROUTE]: status.route })
      const { store, changes, backend } = createStatusStore()
      const update = store.getState().updateLmStudioStatus()
      await waitForMicrotasks()

      backend.isBackendRunning = false
      status.responses[0]?.resolve(
        buildJsonResponse(200, { status: "connected" })
      )
      await update

      expect(changes).toEqual([])
      expect(store.getState().lmStudioStatus).toBe("unknown")
    })
  })

  describe("connectLmStudio", () => {
    it("publishes connecting at once, then the settled status", async () => {
      const connect = createControlledRoute()
      startBackendFake({ [CONNECT_ROUTE]: connect.route })
      const { store, changes } = createStatusStore()

      const connection = store.getState().connectLmStudio()
      const whilePending = store.getState().lmStudioStatus
      await waitForMicrotasks()
      connect.responses[0]?.resolve(
        buildJsonResponse(200, { status: "connected" })
      )
      await connection

      expect(whilePending).toBe("connecting")
      expect(changes).toEqual(["connecting", "connected"])
    })

    it("publishes unknown when the backend refuses the attempt", async () => {
      startBackendFake({
        [CONNECT_ROUTE]: () =>
          buildJsonResponse(503, createLlmServiceBusyProblem())
      })
      const { store, changes } = createStatusStore()

      await expect(store.getState().connectLmStudio()).resolves.toBeUndefined()

      expect(changes).toEqual(["connecting", "unknown"])
    })

    it("does nothing while the backend does not run", async () => {
      const backend = startBackendFake({})
      const { store, changes, backend: owner } = createStatusStore()
      owner.isBackendRunning = false

      await store.getState().connectLmStudio()

      expect(backend.requests).toEqual([])
      expect(changes).toEqual([])
    })
  })

  describe("resetLmStudioStatus", () => {
    it("publishes unknown and never publishes the abandoned request's answer", async () => {
      startBackendFake({ [STATUS_ROUTE]: answerStatus("connected") })
      const pending = createControlledRoute()
      const { store, changes } = createStatusStore()
      await store.getState().updateLmStudioStatus()
      startBackendFake({ [STATUS_ROUTE]: pending.route })
      const readSettlement = createSettlementReader(
        store.getState().updateLmStudioStatus()
      )
      await waitForMicrotasks()

      store.getState().resetLmStudioStatus()
      pending.responses[0]?.resolve(
        buildJsonResponse(200, { status: "unreachable" })
      )
      await waitForMicrotasks()

      expect(changes).toEqual(["connected", "unknown"])
      expect(readSettlement()).toBe("fulfilled")
    })

    it("does not notify when the status is already unknown", () => {
      const { store, changes } = createStatusStore()

      store.getState().resetLmStudioStatus()

      expect(changes).toEqual([])
    })
  })
})
