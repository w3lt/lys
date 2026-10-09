import type { ConversationSummary } from "@lys/protocol"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as conversationApi from "@/lib/apis/http/conversations"
import { createConversationHistoryStore } from "@/lib/store/conversation-history"
import {
  buildJsonResponse,
  startBackendFake,
  type BackendRoute,
  type BackendRoutes
} from "../../../support/backendFake"
import {
  buildConversationListPage,
  buildConversationMetadata,
  buildConversationNotFoundProblem,
  buildConversationSummary,
  createFixtureUuidV7
} from "../../../support/conversationFixtures"
import {
  createControlledPromise,
  waitForMicrotasks,
  type ControlledPromise
} from "../../../support/settlement"

/** Backend origin the store samples; it differs from the production default. */
const BACKEND_URL = "http://backend.test:4100"

/** Time the clock reads when history opens, in epoch milliseconds. */
const OPENED_AT_MS = Date.parse("2026-06-07T08:09:10.000Z")

/** Route key of the conversation list. */
const LIST_ROUTE = "GET /api/v1/conversations"

/** Listed conversations, newest first. */
const TRIP = buildConversationSummary(createFixtureUuidV7(3), "Trip", {
  role: "user",
  content: "Plan a trip"
})
const RECIPE = buildConversationSummary(createFixtureUuidV7(2), "Recipe", null)

/**
 * Creates a history store over the real conversation wrappers, a backend the
 * case controls, a fixed clock, and a recorder of chat-view closes.
 *
 * @returns The store, a switch for whether the backend runs (it starts
 * running), and the conversations the chat view was asked to close.
 */
function createHistoryStore() {
  const backendAvailability = { isRunning: true }
  const closedConversationIds: string[] = []
  const store = createConversationHistoryStore({
    listConversations: conversationApi.listConversations,
    updateConversationTitle: conversationApi.updateConversationTitle,
    deleteConversation: conversationApi.deleteConversation,
    getBackend: () => ({
      backendUrl: BACKEND_URL,
      isRunning: backendAvailability.isRunning
    }),
    getCurrentTimeMs: () => OPENED_AT_MS,
    closeConversation: (conversationId) => {
      closedConversationIds.push(conversationId)
    }
  })
  return { store, backendAvailability, closedConversationIds }
}

/**
 * Builds a list route answering every read with one final page.
 *
 * @param conversations - Listed conversations, newest first.
 * @returns The route.
 */
function buildListRoute(
  conversations: readonly ConversationSummary[]
): BackendRoute {
  return () => buildJsonResponse(200, buildConversationListPage(conversations))
}

/**
 * Builds a list route whose responses stay pending until the case settles them.
 *
 * @returns The route and the pending responses in arrival order.
 */
function createControlledListRoute() {
  const responses: ControlledPromise<Response>[] = []
  const route: BackendRoute = () => {
    const response = createControlledPromise<Response>()
    responses.push(response)
    return response.promise
  }
  return { route, responses }
}

/**
 * Reads the query parameters of every list request, in order.
 *
 * @param backend - Backend observation handle.
 * @returns Each list request's query parameters as an object.
 */
function listListQueries(backend: ReturnType<typeof startBackendFake>) {
  return backend.requests
    .filter((request) => request.method === "GET")
    .map((request) => Object.fromEntries(new URL(request.url).searchParams))
}

/**
 * Opens history over a backend listing the given conversations and waits for
 * the first page.
 *
 * @param conversations - Listed conversations, newest first.
 * @param routes - Routes the case needs afterwards.
 * @returns The opened store harness and the backend observation handle.
 */
async function openLoadedHistory(
  conversations: readonly ConversationSummary[],
  routes: BackendRoutes = {}
) {
  const backend = startBackendFake({
    [LIST_ROUTE]: buildListRoute(conversations),
    ...routes
  })
  const harness = createHistoryStore()
  harness.store.getState().openConversationHistory()
  await waitForMicrotasks()
  return { ...harness, backend }
}

/**
 * Lists the identities of the displayed entries.
 *
 * @param store - History store under test.
 * @returns The displayed conversation identities in order, or undefined when
 * no page is displayed.
 */
function listDisplayedIds(
  store: ReturnType<typeof createHistoryStore>["store"]
) {
  const { list } = store.getState()
  return list.status === "loaded"
    ? list.page.entries.map((entry) => entry.id)
    : undefined
}

afterEach(() => {
  vi.useRealTimers()
})

describe("createConversationHistoryStore", () => {
  it("starts closed with an empty query and nothing read", () => {
    expect(createHistoryStore().store.getState()).toMatchObject({
      visibility: { status: "closed" },
      query: "",
      list: { status: "idle" },
      rowInteraction: { kind: "none" },
      pendingMutations: [],
      mutationError: undefined
    })
  })

  describe("opening and closing", () => {
    it("opens at the clock's time and reads the first page of 30", async () => {
      const { store, backend } = await openLoadedHistory([TRIP, RECIPE])

      expect(store.getState().visibility).toEqual({
        status: "open",
        openedAtMs: OPENED_AT_MS
      })
      expect(listDisplayedIds(store)).toEqual([TRIP.id, RECIPE.id])
      expect(listListQueries(backend)).toEqual([{ limit: "30" }])
      expect(new URL(backend.requests[0]?.url ?? "").origin).toBe(BACKEND_URL)
    })

    it("does not read again when opened while open", async () => {
      const { store, backend } = await openLoadedHistory([TRIP])

      store.getState().openConversationHistory()
      await waitForMicrotasks()

      expect(listListQueries(backend)).toHaveLength(1)
    })

    it("fails without a request while the backend is stopped", () => {
      const backend = startBackendFake({})
      const harness = createHistoryStore()
      harness.backendAvailability.isRunning = false

      harness.store.getState().openConversationHistory()

      expect(harness.store.getState().list).toEqual({
        status: "failed",
        error:
          "The backend is not running, so past conversations cannot be read."
      })
      expect(backend.requests).toEqual([])
    })

    it("shows why the first page could not be read", async () => {
      startBackendFake({ [LIST_ROUTE]: () => buildJsonResponse(500, {}) })
      const { store } = createHistoryStore()

      store.getState().openConversationHistory()
      await waitForMicrotasks()

      expect(store.getState().list).toMatchObject({
        status: "failed",
        error: expect.stringContaining("500")
      })
    })

    it("cancels a pending read on closing and never commits its late answer", async () => {
      const list = createControlledListRoute()
      const backend = startBackendFake({ [LIST_ROUTE]: list.route })
      const { store } = createHistoryStore()
      store.getState().openConversationHistory()
      await waitForMicrotasks()

      store.getState().closeConversationHistory()
      list.responses[0]?.resolve(
        buildJsonResponse(200, buildConversationListPage([TRIP]))
      )
      await waitForMicrotasks()

      expect(store.getState()).toMatchObject({
        visibility: { status: "closed" },
        list: { status: "idle" }
      })
      expect(backend.requests[0]?.signal?.aborted).toBe(true)
    })

    it("keeps the displayed page for the next opening, which reads it again", async () => {
      const { store, backend } = await openLoadedHistory([TRIP])
      store.getState().closeConversationHistory()

      store.getState().openConversationHistory()
      const whileReading = store.getState().list

      expect(whileReading).toMatchObject({
        status: "loaded",
        activity: { status: "refreshing" }
      })
      expect(listDisplayedIds(store)).toEqual([TRIP.id])
      await waitForMicrotasks()
      expect(listListQueries(backend)).toHaveLength(2)
    })

    it("ends the row interaction and clears the mutation error on closing", async () => {
      const { store } = await openLoadedHistory([TRIP])
      store.getState().updateConversationRowInteraction({
        kind: "confirming-delete",
        conversationId: TRIP.id
      })
      store.setState({ mutationError: "Deleting failed." })

      store.getState().closeConversationHistory()

      expect(store.getState()).toMatchObject({
        rowInteraction: { kind: "none" },
        mutationError: undefined
      })
    })
  })

  describe("searching", () => {
    it("marks the list pending at once and reads the trimmed query after a 200 ms pause in typing", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      const { store, backend } = await openLoadedHistory([TRIP])

      store.getState().updateConversationHistoryQuery("tr")
      const whileTyping = store.getState().list
      await vi.advanceTimersByTimeAsync(150)
      store.getState().updateConversationHistoryQuery(" trip ")
      await vi.advanceTimersByTimeAsync(199)
      const queriesBeforePause = listListQueries(backend)
      await vi.advanceTimersByTimeAsync(1)

      expect(whileTyping).toMatchObject({ activity: { status: "refreshing" } })
      expect(queriesBeforePause).toEqual([{ limit: "30" }])
      expect(listListQueries(backend)).toEqual([
        { limit: "30" },
        { query: "trip", limit: "30" }
      ])
      expect(store.getState().list).toMatchObject({ page: { query: "trip" } })
    })

    it("keeps the typed query while closed and searches it only on opening", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      const backend = startBackendFake({ [LIST_ROUTE]: buildListRoute([TRIP]) })
      const { store } = createHistoryStore()

      store.getState().updateConversationHistoryQuery("trip")
      await vi.advanceTimersByTimeAsync(500)
      const whileClosed = store.getState()
      const readsWhileClosed = backend.requests.length
      store.getState().openConversationHistory()
      await waitForMicrotasks()

      expect(whileClosed).toMatchObject({
        query: "trip",
        list: { status: "idle" }
      })
      expect(readsWhileClosed).toBe(0)
      expect(listListQueries(backend)).toEqual([{ query: "trip", limit: "30" }])
    })

    it("reads nothing when the typed query trims to the displayed one", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      const { store, backend } = await openLoadedHistory([TRIP])

      store.getState().updateConversationHistoryQuery("   ")
      await vi.advanceTimersByTimeAsync(500)

      expect(listListQueries(backend)).toHaveLength(1)
      expect(store.getState().list).toMatchObject({
        activity: { status: "idle" }
      })
    })

    it("cancels a waiting search read on closing", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      const { store, backend } = await openLoadedHistory([TRIP])
      store.getState().updateConversationHistoryQuery("trip")

      store.getState().closeConversationHistory()
      await vi.advanceTimersByTimeAsync(500)

      expect(listListQueries(backend)).toHaveLength(1)
    })
  })

  describe("loadFirstConversationId", () => {
    it("reads a waiting search at once and finds its first conversation", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      const { store, backend } = await openLoadedHistory([TRIP, RECIPE])
      store.getState().updateConversationHistoryQuery("recipe")
      startBackendFake({ [LIST_ROUTE]: buildListRoute([RECIPE]) })

      await expect(store.getState().loadFirstConversationId()).resolves.toBe(
        RECIPE.id
      )
      expect(listListQueries(backend)).toHaveLength(1)
    })

    it("finds nothing when the query changes while its read is pending", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      const list = createControlledListRoute()
      startBackendFake({ [LIST_ROUTE]: list.route })
      const { store } = createHistoryStore()
      store.getState().updateConversationHistoryQuery("trip")
      store.getState().openConversationHistory()
      await waitForMicrotasks()
      list.responses[0]?.resolve(
        buildJsonResponse(200, buildConversationListPage([TRIP]))
      )
      await waitForMicrotasks()
      store.getState().updateConversationHistoryQuery("recipe")

      const firstId = store.getState().loadFirstConversationId()
      await waitForMicrotasks()
      store.getState().updateConversationHistoryQuery("trip")

      await expect(firstId).resolves.toBeUndefined()
    })

    it("skips a conversation being deleted", async () => {
      const deletion = createControlledPromise<Response>()
      const { store } = await openLoadedHistory([TRIP, RECIPE], {
        [`DELETE /api/v1/conversations/${TRIP.id}`]: () => deletion.promise
      })
      void store.getState().deleteConversation(TRIP.id)

      await expect(store.getState().loadFirstConversationId()).resolves.toBe(
        RECIPE.id
      )
      deletion.resolve(new Response(null, { status: 204 }))
    })

    it("finds nothing while history is closed", async () => {
      const { store } = await openLoadedHistory([TRIP])
      store.getState().closeConversationHistory()

      await expect(
        store.getState().loadFirstConversationId()
      ).resolves.toBeUndefined()
    })

    it("finds nothing when the displayed page answers another query", async () => {
      const list = createControlledListRoute()
      startBackendFake({ [LIST_ROUTE]: list.route })
      const { store } = createHistoryStore()
      store.getState().openConversationHistory()
      await waitForMicrotasks()
      list.responses[0]?.resolve(
        buildJsonResponse(200, buildConversationListPage([TRIP]))
      )
      await waitForMicrotasks()
      store.setState({ query: "recipe" })

      await expect(
        store.getState().loadFirstConversationId()
      ).resolves.toBeUndefined()
    })
  })

  describe("loadOlderConversations", () => {
    it("reads the next page of the displayed query and appends it", async () => {
      let reads = 0
      const backend = startBackendFake({
        [LIST_ROUTE]: () => {
          reads += 1
          return buildJsonResponse(
            200,
            reads === 1
              ? buildConversationListPage([TRIP], {
                  storedCount: 2,
                  matchCount: 2,
                  nextCursor: "older"
                })
              : buildConversationListPage([RECIPE], { storedCount: 2 })
          )
        }
      })
      const { store } = createHistoryStore()
      store.getState().openConversationHistory()
      await waitForMicrotasks()

      const older = store.getState().loadOlderConversations()
      const whileReading = store.getState().list
      await older

      expect(whileReading).toMatchObject({
        activity: { status: "loading-older" }
      })
      expect(listListQueries(backend)[1]).toEqual({
        cursor: "older",
        limit: "30"
      })
      expect(listDisplayedIds(store)).toEqual([TRIP.id, RECIPE.id])
      expect(store.getState().list).toMatchObject({
        page: { nextCursor: null },
        activity: { status: "idle" }
      })
    })

    it("keeps the displayed entries when the older page fails", async () => {
      let reads = 0
      startBackendFake({
        [LIST_ROUTE]: () => {
          reads += 1
          return reads === 1
            ? buildJsonResponse(
                200,
                buildConversationListPage([TRIP], {
                  storedCount: 2,
                  matchCount: 2,
                  nextCursor: "older"
                })
              )
            : buildJsonResponse(500, {})
        }
      })
      const { store } = createHistoryStore()
      store.getState().openConversationHistory()
      await waitForMicrotasks()

      await store.getState().loadOlderConversations()

      expect(listDisplayedIds(store)).toEqual([TRIP.id])
      expect(store.getState().list).toMatchObject({
        activity: {
          status: "older-failed",
          error: expect.stringContaining("500")
        }
      })
    })

    it("reads nothing on the final page", async () => {
      const { store, backend } = await openLoadedHistory([TRIP])

      await store.getState().loadOlderConversations()

      expect(listListQueries(backend)).toHaveLength(1)
    })
  })
})

/** Route key of the title update for {@link TRIP}. */
const RENAME_TRIP_ROUTE = `PATCH /api/v1/conversations/${TRIP.id}`

/** Route key of the deletion of {@link TRIP}. */
const DELETE_TRIP_ROUTE = `DELETE /api/v1/conversations/${TRIP.id}`

/**
 * Builds a rename route answering with the stored metadata.
 *
 * @param title - Title the backend persisted.
 * @returns The route.
 */
function buildRenameRoute(title: string): BackendRoute {
  return () => buildJsonResponse(200, buildConversationMetadata(TRIP.id, title))
}

describe("conversation history changes", () => {
  it("renames an entry in place with the trimmed title, pending until the backend answers", async () => {
    const rename = createControlledPromise<Response>()
    const { store, backend } = await openLoadedHistory([TRIP, RECIPE], {
      [RENAME_TRIP_ROUTE]: () => rename.promise
    })

    const update = store.getState().updateConversationTitle(TRIP.id, "  Tour  ")
    const whilePending = store.getState().pendingMutations
    rename.resolve(
      buildJsonResponse(200, buildConversationMetadata(TRIP.id, "Tour"))
    )
    await update

    expect(whilePending).toEqual([
      { conversationId: TRIP.id, operation: "update-title" }
    ])
    expect(backend.requests.at(-1)?.body).toEqual({ title: "Tour" })
    expect(store.getState()).toMatchObject({
      pendingMutations: [],
      list: {
        page: {
          entries: [
            { id: TRIP.id, title: "Tour" },
            { id: RECIPE.id, title: "Recipe" }
          ]
        }
      }
    })
  })

  it("ignores a blank title and a second change while one is pending", async () => {
    const rename = createControlledPromise<Response>()
    const { store, backend } = await openLoadedHistory([TRIP], {
      [RENAME_TRIP_ROUTE]: () => rename.promise
    })

    await store.getState().updateConversationTitle(TRIP.id, "   ")
    const first = store.getState().updateConversationTitle(TRIP.id, "Tour")
    await store.getState().deleteConversation(TRIP.id)
    rename.resolve(
      buildJsonResponse(200, buildConversationMetadata(TRIP.id, "Tour"))
    )
    await first

    expect(backend.requests.map((request) => request.method)).toEqual([
      "GET",
      "PATCH"
    ])
  })

  it("removes a renamed conversation that no longer exists and closes it in the chat view", async () => {
    const { store, closedConversationIds } = await openLoadedHistory(
      [TRIP, RECIPE],
      {
        [RENAME_TRIP_ROUTE]: () =>
          buildJsonResponse(404, buildConversationNotFoundProblem())
      }
    )

    await store.getState().updateConversationTitle(TRIP.id, "Tour")

    expect(listDisplayedIds(store)).toEqual([RECIPE.id])
    expect(store.getState().mutationError).toBe(
      "That conversation no longer exists."
    )
    expect(closedConversationIds).toEqual([TRIP.id])
  })

  it("reports a failed rename and keeps the entry", async () => {
    const { store } = await openLoadedHistory([TRIP], {
      [RENAME_TRIP_ROUTE]: () => buildJsonResponse(500, {})
    })

    await store.getState().updateConversationTitle(TRIP.id, "Tour")

    expect(store.getState()).toMatchObject({
      mutationError: expect.stringMatching(/^Renaming failed: .*500/),
      pendingMutations: [],
      list: { page: { entries: [{ id: TRIP.id, title: "Trip" }] } }
    })
  })

  it.each([
    ["the backend deletes it", () => new Response(null, { status: 204 })],
    [
      "it was already gone",
      () => buildJsonResponse(404, buildConversationNotFoundProblem())
    ]
  ])(
    "removes a deleted entry and closes it in the chat view when %s",
    async (_label, route) => {
      const { store, closedConversationIds } = await openLoadedHistory(
        [TRIP, RECIPE],
        { [DELETE_TRIP_ROUTE]: route }
      )

      await store.getState().deleteConversation(TRIP.id)

      expect(listDisplayedIds(store)).toEqual([RECIPE.id])
      expect(store.getState().list).toMatchObject({
        page: { storedCount: 1, matchCount: 1 }
      })
      expect(closedConversationIds).toEqual([TRIP.id])
    }
  )

  it("reports a failed deletion and keeps the entry", async () => {
    const { store, closedConversationIds } = await openLoadedHistory([TRIP], {
      [DELETE_TRIP_ROUTE]: () => buildJsonResponse(500, {})
    })

    await store.getState().deleteConversation(TRIP.id)

    expect(store.getState().mutationError).toMatch(/^Deleting failed: .*500/)
    expect(listDisplayedIds(store)).toEqual([TRIP.id])
    expect(closedConversationIds).toEqual([])
  })

  it("reports a stopped backend without a request or a pending change", async () => {
    const { store, backend, backendAvailability } = await openLoadedHistory([
      TRIP
    ])
    backendAvailability.isRunning = false

    await store.getState().deleteConversation(TRIP.id)

    expect(store.getState()).toMatchObject({
      mutationError: "The backend is not running, so the change was not made.",
      pendingMutations: []
    })
    expect(backend.requests.map((request) => request.method)).toEqual(["GET"])
  })

  it("saves a changed title still being edited when history closes, and the rename continues", async () => {
    const { store, backend } = await openLoadedHistory([TRIP], {
      [RENAME_TRIP_ROUTE]: buildRenameRoute("Tour")
    })
    store.getState().updateConversationRowInteraction({
      kind: "editing-title",
      conversationId: TRIP.id,
      draftTitle: " Tour "
    })

    store.getState().closeConversationHistory()
    await waitForMicrotasks()

    expect(backend.requests.at(-1)?.body).toEqual({ title: "Tour" })
    expect(store.getState().list).toMatchObject({
      page: { entries: [{ id: TRIP.id, title: "Tour" }] }
    })
  })

  it.each([
    ["unchanged", "Trip"],
    ["blank", "  "]
  ])(
    "does not save a title left %s when history closes",
    async (_label, draftTitle) => {
      const { store, backend } = await openLoadedHistory([TRIP])
      store.getState().updateConversationRowInteraction({
        kind: "editing-title",
        conversationId: TRIP.id,
        draftTitle
      })

      store.getState().closeConversationHistory()
      await waitForMicrotasks()

      expect(backend.requests.map((request) => request.method)).toEqual(["GET"])
    }
  )

  it("replaces a first-page read pending when a change settles, so its old answer cannot undo the change", async () => {
    const list = createControlledListRoute()
    const backend = startBackendFake({
      [LIST_ROUTE]: list.route,
      [DELETE_TRIP_ROUTE]: () => new Response(null, { status: 204 })
    })
    const { store } = createHistoryStore()
    store.getState().openConversationHistory()
    await waitForMicrotasks()
    list.responses[0]?.resolve(
      buildJsonResponse(200, buildConversationListPage([TRIP, RECIPE]))
    )
    await waitForMicrotasks()
    void store.getState().loadConversationHistory()
    await waitForMicrotasks()

    await store.getState().deleteConversation(TRIP.id)
    list.responses[1]?.resolve(
      buildJsonResponse(200, buildConversationListPage([TRIP, RECIPE]))
    )
    list.responses[2]?.resolve(
      buildJsonResponse(200, buildConversationListPage([RECIPE]))
    )
    await waitForMicrotasks()

    expect(listListQueries(backend)).toHaveLength(3)
    expect(
      backend.requests.filter((request) => request.method === "GET")[1]?.signal
        ?.aborted
    ).toBe(true)
    expect(listDisplayedIds(store)).toEqual([RECIPE.id])
  })
})
