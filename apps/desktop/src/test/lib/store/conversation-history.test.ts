import type {
  ListConversationsApiQuery,
  ListConversationsApiResponse
} from "@lys/protocol"
import { describe, expect, it, vi } from "vitest"

import type {
  ConversationApiConnection,
  DeleteConversationResult,
  UpdateConversationTitleResult
} from "@/lib/apis/http/conversations"
import {
  type ConversationHistoryListState,
  createConversationHistoryStore
} from "@/lib/store/conversation-history"

import {
  buildConversationSummary,
  buildListPage,
  createDeferred,
  type Deferred,
  FIXTURE_IDS,
  FIXTURE_TIMESTAMP
} from "../../fixtures/conversations"

const BACKEND_URL = "http://127.0.0.1:12345"
const OPENED_AT_MS = Date.parse("2026-09-11T12:00:00.000Z")

/** One list read observed by the fake transport. */
type ListRead = {
  /** Parameters the store sent. */
  readonly query: ListConversationsApiQuery
  /** Connection the store supplied. */
  readonly connection: ConversationApiConnection
  /** Settlement controlled by the test. */
  readonly response: Deferred<ListConversationsApiResponse>
}

/**
 * Creates a history store whose transport is settled explicitly by the test.
 *
 * @param isBackendRunning - Whether the fake backend admits requests.
 * @returns The store, the observed list reads, and mutation fakes.
 */
function createHarness(isBackendRunning = true) {
  const listReads: ListRead[] = []
  const updateConversationTitle =
    vi.fn<
      (
        update: { conversationId: string; title: string },
        connection: ConversationApiConnection
      ) => Promise<UpdateConversationTitleResult>
    >()
  const deleteConversation =
    vi.fn<
      (
        conversationId: string,
        connection: ConversationApiConnection
      ) => Promise<DeleteConversationResult>
    >()
  const closeConversation = vi.fn<(conversationId: string) => void>()
  const store = createConversationHistoryStore({
    listConversations: (query, connection) => {
      const response = createDeferred<ListConversationsApiResponse>()
      listReads.push({ query, connection, response })
      return response.promise
    },
    updateConversationTitle,
    deleteConversation,
    getBackend: () => ({
      backendUrl: BACKEND_URL,
      isRunning: isBackendRunning
    }),
    getCurrentTimeMs: () => OPENED_AT_MS,
    closeConversation
  })

  return {
    store,
    listReads,
    updateConversationTitle,
    deleteConversation,
    closeConversation
  }
}

/** Two listed conversations, newest first, matching nothing in particular. */
const TWO_CONVERSATIONS_PAGE = buildListPage({
  conversations: [
    buildConversationSummary({
      id: FIXTURE_IDS.firstConversation,
      title: "First",
      updatedAt: "2026-09-11T11:50:00.000Z",
      preview: { role: "assistant", content: "**Bold** reply" }
    }),
    buildConversationSummary({
      id: FIXTURE_IDS.secondConversation,
      title: null,
      updatedAt: FIXTURE_TIMESTAMP,
      preview: null
    })
  ],
  storedCount: 2,
  matchCount: 2,
  nextCursor: null
})

/**
 * Reads the displayed entry identities, failing unless a page is displayed.
 *
 * @param list - List state under test.
 * @returns Entry identities in display order.
 */
function readDisplayedIds(list: ConversationHistoryListState): string[] {
  if (list.status !== "loaded") throw new Error(`List is ${list.status}`)
  return list.page.entries.map((entry) => entry.id)
}

/**
 * Lets every already-settled promise continuation run.
 *
 * @returns A promise resolving on the next macrotask, after all microtasks
 * queued by earlier settlements; it is an ordering barrier, not a delay.
 */
function flushPendingWork(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Opens history and settles its first read with the two-conversation page.
 *
 * @param harness - Harness whose store is opened.
 */
async function openWithTwoConversations(
  harness: ReturnType<typeof createHarness>
): Promise<void> {
  harness.store.getState().openConversationHistory()
  harness.listReads[0].response.resolve(TWO_CONVERSATIONS_PAGE)
  await vi.waitFor(() =>
    expect(harness.store.getState().list.status).toBe("loaded")
  )
}

describe("opening and reading history", () => {
  it("shows the panel at the sampled time and reads the unfiltered first page", async () => {
    const harness = createHarness()

    harness.store.getState().openConversationHistory()

    const opened = harness.store.getState()
    expect(opened.visibility).toEqual({
      status: "open",
      openedAtMs: OPENED_AT_MS
    })
    expect(opened.list).toEqual({ status: "loading" })
    expect(harness.listReads).toHaveLength(1)
    expect(harness.listReads[0].query).toEqual({ limit: 30 })
    expect(harness.listReads[0].connection.backendUrl).toBe(BACKEND_URL)

    harness.listReads[0].response.resolve(TWO_CONVERSATIONS_PAGE)
    await vi.waitFor(() =>
      expect(harness.store.getState().list.status).toBe("loaded")
    )
    const list = harness.store.getState().list
    expect(readDisplayedIds(list)).toEqual([
      FIXTURE_IDS.firstConversation,
      FIXTURE_IDS.secondConversation
    ])
    expect(list.status === "loaded" && list.page.entries[0].excerpt).toEqual({
      speaker: "assistant",
      text: "Bold reply"
    })
  })

  it("fails without a request while the backend is stopped", () => {
    const harness = createHarness(false)

    harness.store.getState().openConversationHistory()

    expect(harness.listReads).toHaveLength(0)
    expect(harness.store.getState().list).toEqual({
      status: "failed",
      error: "The backend is not running, so past conversations cannot be read."
    })
  })

  it("records a failed first read and retries with a real new read", async () => {
    const harness = createHarness()
    harness.store.getState().openConversationHistory()

    harness.listReads[0].response.reject(new Error("HTTP 500"))
    await vi.waitFor(() =>
      expect(harness.store.getState().list).toEqual({
        status: "failed",
        error: "HTTP 500"
      })
    )

    void harness.store.getState().loadConversationHistory()
    expect(harness.listReads).toHaveLength(2)
    expect(harness.store.getState().list).toEqual({ status: "loading" })
  })
})

describe("searching", () => {
  it("replaces an older read and ignores its late response", async () => {
    const harness = createHarness()
    await openWithTwoConversations(harness)

    harness.store.getState().updateConversationHistoryQuery("fir")
    harness.store.getState().updateConversationHistoryQuery("first ")
    expect(harness.listReads).toHaveLength(3)
    expect(harness.listReads[1].connection.signal?.aborted).toBe(true)
    expect(harness.listReads[2].query).toEqual({ query: "first", limit: 30 })

    const list = harness.store.getState().list
    expect(list.status === "loaded" && list.activity.status).toBe("refreshing")

    harness.listReads[2].response.resolve(
      buildListPage({
        conversations: [TWO_CONVERSATIONS_PAGE.conversations[0]],
        storedCount: 2,
        matchCount: 1,
        nextCursor: null
      })
    )
    await vi.waitFor(() => {
      const settled = harness.store.getState().list
      expect(settled.status === "loaded" && settled.page.query).toBe("first")
    })

    harness.listReads[1].response.resolve(
      buildListPage({
        conversations: [],
        storedCount: 2,
        matchCount: 0,
        nextCursor: null
      })
    )
    await flushPendingWork()
    expect(readDisplayedIds(harness.store.getState().list)).toEqual([
      FIXTURE_IDS.firstConversation
    ])
  })

  it("does not read again for a query equal to the displayed one once trimmed", async () => {
    const harness = createHarness()
    await openWithTwoConversations(harness)

    harness.store.getState().updateConversationHistoryQuery("   ")

    expect(harness.store.getState().query).toBe("   ")
    expect(harness.listReads).toHaveLength(1)
  })

  it("keeps the typed query without reading while history is closed", () => {
    const harness = createHarness()

    harness.store.getState().updateConversationHistoryQuery("later")

    expect(harness.store.getState().query).toBe("later")
    expect(harness.listReads).toHaveLength(0)
  })
})

describe("closing", () => {
  it("cancels the list read, keeps the displayed page, and ignores the late response", async () => {
    const harness = createHarness()
    await openWithTwoConversations(harness)
    harness.store.getState().updateConversationHistoryQuery("fir")

    harness.store.getState().closeConversationHistory()

    expect(harness.listReads[1].connection.signal?.aborted).toBe(true)
    const closed = harness.store.getState()
    expect(closed.visibility).toEqual({ status: "closed" })
    expect(closed.list.status === "loaded" && closed.list.activity).toEqual({
      status: "idle"
    })

    harness.listReads[1].response.resolve(
      buildListPage({
        conversations: [],
        storedCount: 2,
        matchCount: 0,
        nextCursor: null
      })
    )
    await flushPendingWork()
    expect(readDisplayedIds(harness.store.getState().list)).toHaveLength(2)
  })
})

describe("reading older conversations", () => {
  it("appends the next page for the displayed query and skips repeated identities", async () => {
    const harness = createHarness()
    harness.store.getState().openConversationHistory()
    harness.listReads[0].response.resolve({
      ...TWO_CONVERSATIONS_PAGE,
      storedCount: 3,
      matchCount: 3,
      nextCursor: "cursor-2"
    })
    await vi.waitFor(() =>
      expect(harness.store.getState().list.status).toBe("loaded")
    )

    void harness.store.getState().loadOlderConversations()
    void harness.store.getState().loadOlderConversations()

    expect(harness.listReads).toHaveLength(2)
    expect(harness.listReads[1].query).toEqual({
      cursor: "cursor-2",
      limit: 30
    })
    harness.listReads[1].response.resolve(
      buildListPage({
        conversations: [
          TWO_CONVERSATIONS_PAGE.conversations[1],
          buildConversationSummary({
            id: FIXTURE_IDS.thirdConversation,
            title: "Third",
            updatedAt: "2026-09-01T10:00:00.000Z",
            preview: null
          })
        ],
        storedCount: 3,
        matchCount: 3,
        nextCursor: null
      })
    )
    await vi.waitFor(() =>
      expect(readDisplayedIds(harness.store.getState().list)).toEqual([
        FIXTURE_IDS.firstConversation,
        FIXTURE_IDS.secondConversation,
        FIXTURE_IDS.thirdConversation
      ])
    )
  })

  it("keeps the displayed entries when the older page fails", async () => {
    const harness = createHarness()
    harness.store.getState().openConversationHistory()
    harness.listReads[0].response.resolve({
      ...TWO_CONVERSATIONS_PAGE,
      nextCursor: "cursor-2"
    })
    await vi.waitFor(() =>
      expect(harness.store.getState().list.status).toBe("loaded")
    )

    void harness.store.getState().loadOlderConversations()
    harness.listReads[1].response.reject(new Error("HTTP 503"))

    await vi.waitFor(() => {
      const list = harness.store.getState().list
      expect(list.status === "loaded" && list.activity).toEqual({
        status: "older-failed",
        error: "HTTP 503"
      })
    })
    expect(readDisplayedIds(harness.store.getState().list)).toHaveLength(2)
  })
})

describe("renaming", () => {
  it("persists the trimmed title and replaces it in place", async () => {
    const harness = createHarness()
    await openWithTwoConversations(harness)
    const result = createDeferred<UpdateConversationTitleResult>()
    harness.updateConversationTitle.mockReturnValue(result.promise)

    const renaming = harness.store
      .getState()
      .updateConversationTitle(FIXTURE_IDS.secondConversation, "  Renamed  ")

    expect(harness.updateConversationTitle).toHaveBeenCalledWith(
      { conversationId: FIXTURE_IDS.secondConversation, title: "Renamed" },
      { backendUrl: BACKEND_URL }
    )
    expect(harness.store.getState().pendingMutations).toEqual([
      {
        conversationId: FIXTURE_IDS.secondConversation,
        operation: "update-title"
      }
    ])
    void harness.store
      .getState()
      .updateConversationTitle(FIXTURE_IDS.secondConversation, "Again")
    expect(harness.updateConversationTitle).toHaveBeenCalledTimes(1)

    result.resolve({
      status: "updated",
      conversation: {
        id: FIXTURE_IDS.secondConversation,
        title: "Renamed",
        systemPrompt: "You are Lys.",
        createdAt: FIXTURE_TIMESTAMP,
        updatedAt: "2026-09-11T11:59:00.000Z"
      }
    })
    await renaming

    const state = harness.store.getState()
    expect(state.pendingMutations).toEqual([])
    expect(readDisplayedIds(state.list)).toEqual([
      FIXTURE_IDS.firstConversation,
      FIXTURE_IDS.secondConversation
    ])
    expect(
      state.list.status === "loaded" && state.list.page.entries[1].title
    ).toBe("Renamed")
  })

  it("ignores a blank title", async () => {
    const harness = createHarness()
    await openWithTwoConversations(harness)

    await harness.store
      .getState()
      .updateConversationTitle(FIXTURE_IDS.firstConversation, "   ")

    expect(harness.updateConversationTitle).not.toHaveBeenCalled()
  })

  it("removes a conversation that is no longer stored and closes it in the chat view", async () => {
    const harness = createHarness()
    await openWithTwoConversations(harness)
    harness.updateConversationTitle.mockResolvedValue({ status: "not-found" })

    await harness.store
      .getState()
      .updateConversationTitle(FIXTURE_IDS.firstConversation, "Renamed")

    const state = harness.store.getState()
    expect(readDisplayedIds(state.list)).toEqual([
      FIXTURE_IDS.secondConversation
    ])
    expect(state.mutationError).toBe("That conversation no longer exists.")
    expect(harness.closeConversation).toHaveBeenCalledWith(
      FIXTURE_IDS.firstConversation
    )
  })

  it("keeps the entry and records a failed rename", async () => {
    const harness = createHarness()
    await openWithTwoConversations(harness)
    harness.updateConversationTitle.mockRejectedValue(new Error("HTTP 500"))

    await harness.store
      .getState()
      .updateConversationTitle(FIXTURE_IDS.firstConversation, "Renamed")

    const state = harness.store.getState()
    expect(state.mutationError).toBe("Renaming failed: HTTP 500")
    expect(
      state.list.status === "loaded" && state.list.page.entries[0].title
    ).toBe("First")
    expect(state.pendingMutations).toEqual([])
  })

  it("records a change requested while the backend is stopped without sending it", async () => {
    const harness = createHarness(false)

    await harness.store
      .getState()
      .updateConversationTitle(FIXTURE_IDS.firstConversation, "Renamed")

    expect(harness.updateConversationTitle).not.toHaveBeenCalled()
    expect(harness.store.getState().mutationError).toBe(
      "The backend is not running, so the change was not made."
    )
  })
})

describe("deleting", () => {
  it.each<DeleteConversationResult>([
    { status: "deleted" },
    { status: "not-found" }
  ])(
    "removes the entry, lowers both counts, and closes it in the chat view when $status",
    async (result) => {
      const harness = createHarness()
      await openWithTwoConversations(harness)
      harness.deleteConversation.mockResolvedValue(result)

      await harness.store
        .getState()
        .deleteConversation(FIXTURE_IDS.firstConversation)

      const list = harness.store.getState().list
      expect(readDisplayedIds(list)).toEqual([FIXTURE_IDS.secondConversation])
      expect(list.status === "loaded" && list.page.storedCount).toBe(1)
      expect(list.status === "loaded" && list.page.matchCount).toBe(1)
      expect(harness.closeConversation).toHaveBeenCalledWith(
        FIXTURE_IDS.firstConversation
      )
    }
  )

  it("keeps the entry and records a failed deletion", async () => {
    const harness = createHarness()
    await openWithTwoConversations(harness)
    harness.deleteConversation.mockRejectedValue(new Error("HTTP 500"))

    await harness.store
      .getState()
      .deleteConversation(FIXTURE_IDS.firstConversation)

    const state = harness.store.getState()
    expect(readDisplayedIds(state.list)).toHaveLength(2)
    expect(state.mutationError).toBe("Deleting failed: HTTP 500")
    expect(harness.closeConversation).not.toHaveBeenCalled()
  })

  it("lets a deletion finish after history closes", async () => {
    const harness = createHarness()
    await openWithTwoConversations(harness)
    const result = createDeferred<DeleteConversationResult>()
    harness.deleteConversation.mockReturnValue(result.promise)

    const deleting = harness.store
      .getState()
      .deleteConversation(FIXTURE_IDS.firstConversation)
    harness.store.getState().closeConversationHistory()
    result.resolve({ status: "deleted" })
    await deleting

    expect(readDisplayedIds(harness.store.getState().list)).toEqual([
      FIXTURE_IDS.secondConversation
    ])
    expect(harness.closeConversation).toHaveBeenCalledWith(
      FIXTURE_IDS.firstConversation
    )
  })
})
