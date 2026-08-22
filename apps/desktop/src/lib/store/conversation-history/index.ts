import type {
  ConversationListApiQuery,
  ConversationListApiResponse,
  ConversationSummary,
  ConversationUpdateTitleApiResponse
} from "@lys/protocol"
import type { Conversation } from "@lys/share"
import { create, type StoreApi, type UseBoundStore } from "zustand"

import {
  type ConversationApiOptions,
  deleteConversation,
  getConversation,
  listConversations,
  updateConversationTitle
} from "@/lib/apis/http/conversations"

import { useChatViewStore } from "@/lib/store/chat-view"
import { useLysStore } from "@/lib/store"

/** Cancels one scheduled search reload that has not run yet. */
export type CancelScheduledConversationSearch = () => void

/** Runtime dependencies used by one conversation history store instance. */
export type ConversationHistoryStoreDependencies = {
  /** Lists one page of stored conversations. */
  readonly listConversations: (
    query: ConversationListApiQuery,
    options?: ConversationApiOptions
  ) => Promise<ConversationListApiResponse>
  /** Reads one stored conversation and its complete transcript. */
  readonly getConversation: (
    conversationId: string,
    options?: ConversationApiOptions
  ) => Promise<Conversation>
  /** Persists a replacement title for one stored conversation. */
  readonly updateConversationTitle: (
    conversationId: string,
    title: string,
    options?: ConversationApiOptions
  ) => Promise<ConversationUpdateTitleApiResponse>
  /** Permanently deletes one stored conversation. */
  readonly deleteConversation: (
    conversationId: string,
    options?: ConversationApiOptions
  ) => Promise<void>
  /** Makes one stored conversation the active chat conversation. */
  readonly openChatConversation: (conversation: Conversation) => void
  /** Presents the chat view so the opened conversation becomes visible. */
  readonly openChatView: () => void
  /** Ends the active chat conversation when it was the deleted one. */
  readonly closeChatConversation: (conversationId: string) => void
  /** Applies a persisted title to the active chat conversation. */
  readonly updateChatConversationTitle: (
    conversationId: string,
    title: string
  ) => void
  /** Reads the current instant as epoch milliseconds. */
  readonly getCurrentTimestamp: () => number
  /**
   * Defers one search reload until the user pauses typing.
   *
   * @remarks Called with the reload to run and returns its canceller. The
   * store cancels a pending reload before scheduling another one and when the
   * panel closes, so at most one reload is ever scheduled.
   */
  readonly scheduleConversationSearch: (
    reloadConversations: () => void
  ) => CancelScheduledConversationSearch
}

/** One loaded page range of the conversation history list. */
export type ConversationHistoryPage = {
  /** Conversations loaded so far, in backend presentation order. */
  readonly conversations: readonly ConversationSummary[]
  /** Number of stored conversations, ignoring the search query. */
  readonly total: number
  /** Number of conversations matching the search query. */
  readonly matchCount: number
  /** Cursor continuing this result, or null when the result is complete. */
  readonly nextCursor: string | null
  /**
   * Instant this result began, as epoch milliseconds.
   *
   * @remarks Day grouping and relative times are calculated against this
   * instant so rendering never reads the clock. It is captured once for the
   * first page and preserved while further pages are appended, so the labels
   * of an open panel stay stable until the list is read again.
   */
  readonly listedAt: number
}

/** Observable state of the conversation history list. */
export type ConversationHistoryListState =
  | {
      /** No list request has been made for the current search query. */
      readonly status: "idle"
    }
  | {
      /** The first page of the current search query is being read. */
      readonly status: "loading"
    }
  | {
      /** The first page could not be read and no conversations are shown. */
      readonly status: "failed"
      /** Failure presented in place of the list. */
      readonly error: string
    }
  | {
      /** Every page requested so far is available. */
      readonly status: "loaded"
      /** Conversations loaded so far and their result counts. */
      readonly page: ConversationHistoryPage
    }
  | {
      /** A further page is being appended to the loaded conversations. */
      readonly status: "loading-next-page"
      /** Conversations loaded so far and their result counts. */
      readonly page: ConversationHistoryPage
    }
  | {
      /** A further page could not be read; loaded conversations remain. */
      readonly status: "next-page-failed"
      /** Conversations loaded so far and their result counts. */
      readonly page: ConversationHistoryPage
      /** Failure presented beneath the loaded conversations. */
      readonly error: string
    }

/** Observable state of the single conversation operation the store allows. */
export type ConversationHistoryOperationState =
  | {
      /** No conversation operation is running. */
      readonly status: "idle"
    }
  | {
      /** One conversation is being renamed. */
      readonly status: "renaming"
      /** Conversation whose title is being persisted. */
      readonly conversationId: string
    }
  | {
      /** One conversation is being deleted. */
      readonly status: "deleting"
      /** Conversation being permanently removed. */
      readonly conversationId: string
    }
  | {
      /** One conversation is being read before it becomes active. */
      readonly status: "opening"
      /** Conversation being read from the backend. */
      readonly conversationId: string
    }
  | {
      /** The last conversation operation failed. */
      readonly status: "failed"
      /** Failure presented until the next operation starts. */
      readonly error: string
    }

/** Observable state rendered by the conversation history panel. */
export type ConversationHistoryState = {
  /** Whether the history panel is presented over the application. */
  readonly isPanelOpen: boolean
  /** Current search text, owned by this store and echoed by the field. */
  readonly searchQuery: string
  /** Authoritative list lifecycle for the current search query. */
  readonly list: ConversationHistoryListState
  /** Authoritative lifecycle of the single allowed conversation operation. */
  readonly operation: ConversationHistoryOperationState
}

/** Actions that mutate or advance the conversation history lifecycle. */
export type ConversationHistoryActions = {
  /** Presents the panel and reloads the current search query. */
  openHistoryPanel: () => void
  /** Hides the panel, cancelling any scheduled or running list request. */
  closeHistoryPanel: () => void
  /** Replaces the search text and defers a reload until typing pauses. */
  setSearchQuery: (searchQuery: string) => void
  /** Reads the first page of the current search query, replacing the list. */
  loadConversations: () => Promise<void>
  /** Appends the next page to the loaded conversations. */
  loadNextConversationPage: () => Promise<void>
  /** Persists a replacement title for one listed conversation. */
  updateConversationTitle: (
    conversationId: string,
    title: string
  ) => Promise<ConversationOperationOutcome>
  /** Permanently deletes one listed conversation. */
  deleteConversation: (
    conversationId: string
  ) => Promise<ConversationOperationOutcome>
  /** Opens one listed conversation in the chat view and hides the panel. */
  openConversation: (
    conversationId: string
  ) => Promise<ConversationOperationOutcome>
}

/**
 * Outcome of one conversation operation requested by the panel.
 *
 * @remarks `rejected` means the operation never started because another one
 * was already running or its input was blank, so nothing changed.
 */
export type ConversationOperationOutcome = "succeeded" | "rejected" | "failed"

/** State and actions exposed by one conversation history Zustand store. */
export type ConversationHistoryStore = ConversationHistoryState &
  ConversationHistoryActions

/**
 * Conversations requested per page.
 *
 * @remarks Applied by this store to every list request. The backend enforces
 * its own maximum and rejects a larger value.
 */
const CONVERSATION_HISTORY_PAGE_SIZE = 30

/**
 * Quiet period observed before a changed search query is sent.
 *
 * @remarks Trailing-edge only: each keystroke replaces the pending reload, and
 * closing the panel cancels it without running.
 */
const CONVERSATION_SEARCH_DEBOUNCE_MS = 200

/** Initial observable state shared by independent history stores. */
const INITIAL_CONVERSATION_HISTORY_STATE: Readonly<ConversationHistoryState> =
  Object.freeze({
    isPanelOpen: false,
    searchQuery: "",
    list: Object.freeze({ status: "idle" }),
    operation: Object.freeze({ status: "idle" })
  })

/** Outcome of applying one change to the conversations already loaded. */
type LoadedConversationPageUpdate =
  | {
      /** The change was applied to the loaded conversations. */
      readonly status: "applied"
      /** List state carrying the changed conversations. */
      readonly list: ConversationHistoryListState
    }
  | {
      /** No settled page existed, so the caller must read the list again. */
      readonly status: "not-applicable"
    }

/** Store-private transport resource correlated with one list request. */
type ConversationListRequestResource = {
  /** Token correlating this resource with the newest list request. */
  readonly token: number
  /** Controller owned exclusively by the store. */
  readonly abortController: AbortController
}

/**
 * Converts an unknown thrown value into a user-presentable failure message.
 *
 * @param error - Value thrown while reading or changing conversation history.
 * @returns A non-empty message suitable for inline presentation.
 */
function formatConversationErrorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Conversation history request failed."
}

/**
 * Selects the loaded page carried by a list state, when one exists.
 *
 * @param list - Current authoritative list lifecycle state.
 * @returns The loaded page, or undefined while no page is available.
 */
export function findLoadedConversationPage(
  list: ConversationHistoryListState
): ConversationHistoryPage | undefined {
  switch (list.status) {
    case "idle":
    case "loading":
    case "failed":
      return undefined
    case "loaded":
    case "loading-next-page":
    case "next-page-failed":
      return list.page
  }
}

/**
 * Builds the list query for one page of the current search.
 *
 * @param searchQuery - Current search text, which may be blank.
 * @param cursor - Continuation cursor, or null for the first page.
 * @returns The query omitting members the backend treats as absent.
 */
function buildConversationListQuery(
  searchQuery: string,
  cursor: string | null
): ConversationListApiQuery {
  const trimmedQuery = searchQuery.trim()

  return {
    limit: CONVERSATION_HISTORY_PAGE_SIZE,
    ...(trimmedQuery === "" ? {} : { query: trimmedQuery }),
    ...(cursor === null ? {} : { cursor })
  }
}

/**
 * Creates the page holding the first response of a search.
 *
 * @param response - Validated first page returned by the backend.
 * @param listedAt - Instant the result began, as epoch milliseconds.
 * @returns A frozen page carrying that response.
 */
function createConversationHistoryPage(
  response: ConversationListApiResponse,
  listedAt: number
): ConversationHistoryPage {
  return Object.freeze({
    conversations: Object.freeze([...response.conversations]),
    total: response.total,
    matchCount: response.matchCount,
    nextCursor: response.nextCursor,
    listedAt
  })
}

/**
 * Appends a further page to the conversations already loaded.
 *
 * @param page - Conversations loaded so far for the current search.
 * @param response - Validated next page returned by the backend.
 * @returns A frozen page whose conversations keep backend order.
 * @remarks A conversation already present is ignored rather than repeated,
 * because an update between requests can move it into a later page.
 */
function appendConversationHistoryPage(
  page: ConversationHistoryPage,
  response: ConversationListApiResponse
): ConversationHistoryPage {
  const loadedIds = new Set(
    page.conversations.map((conversation) => conversation.id)
  )
  const appendedConversations = response.conversations.filter(
    (conversation) => !loadedIds.has(conversation.id)
  )

  return Object.freeze({
    conversations: Object.freeze([
      ...page.conversations,
      ...appendedConversations
    ]),
    total: response.total,
    matchCount: response.matchCount,
    nextCursor: response.nextCursor,
    listedAt: page.listedAt
  })
}

/**
 * Replaces the title of one listed conversation.
 *
 * @param page - Conversations currently loaded.
 * @param renamedConversation - Metadata persisted by the backend.
 * @returns A frozen page carrying the persisted title and update time.
 * @remarks List order is not recalculated, so the renamed conversation keeps
 * its position until the list is loaded again.
 */
function updateConversationHistoryPageTitle(
  page: ConversationHistoryPage,
  renamedConversation: ConversationUpdateTitleApiResponse
): ConversationHistoryPage {
  const conversations = page.conversations.map((conversation) =>
    conversation.id === renamedConversation.id
      ? Object.freeze({
          ...conversation,
          title: renamedConversation.title,
          updatedAt: renamedConversation.updatedAt
        })
      : conversation
  )

  return Object.freeze({ ...page, conversations: Object.freeze(conversations) })
}

/**
 * Removes one deleted conversation from the loaded conversations.
 *
 * @param page - Conversations currently loaded.
 * @param conversationId - Conversation the backend deleted.
 * @returns A frozen page without that conversation and with reduced counts.
 */
function removeConversationFromHistoryPage(
  page: ConversationHistoryPage,
  conversationId: string
): ConversationHistoryPage {
  const conversations = page.conversations.filter(
    (conversation) => conversation.id !== conversationId
  )
  const removedCount = page.conversations.length - conversations.length

  return Object.freeze({
    conversations: Object.freeze(conversations),
    total: Math.max(0, page.total - removedCount),
    matchCount: Math.max(0, page.matchCount - removedCount),
    nextCursor: page.nextCursor,
    listedAt: page.listedAt
  })
}

/**
 * Creates one independently owned conversation history store.
 *
 * @param dependencies - Transport, chat, and scheduling capabilities.
 * @returns A Zustand hook and store API owning one history lifecycle.
 */
export function createConversationHistoryStore(
  dependencies: ConversationHistoryStoreDependencies
): UseBoundStore<StoreApi<ConversationHistoryStore>> {
  let nextListRequestToken = 1
  let activeListRequest: ConversationListRequestResource | undefined
  let cancelScheduledSearch: CancelScheduledConversationSearch | undefined

  /**
   * Creates the state and actions owning this store's history lifecycle.
   *
   * @param set - Zustand capability that applies observable state changes.
   * @param get - Zustand capability that reads current observable state.
   * @returns Initial history state and its lifecycle actions.
   */
  function createConversationHistoryStoreState(
    set: StoreApi<ConversationHistoryStore>["setState"],
    get: StoreApi<ConversationHistoryStore>["getState"]
  ): ConversationHistoryStore {
    /** Cancels any pending debounce and abandons any running list request. */
    function cancelListWork(): void {
      cancelScheduledSearch?.()
      cancelScheduledSearch = undefined
      activeListRequest?.abortController.abort()
      activeListRequest = undefined
    }

    /**
     * Replaces the active list request with a newly authorized one.
     *
     * @returns The private resource authorizing the new list request.
     */
    function startListRequest(): ConversationListRequestResource {
      activeListRequest?.abortController.abort()

      const request = Object.freeze({
        token: nextListRequestToken,
        abortController: new AbortController()
      })
      nextListRequestToken += 1
      activeListRequest = request

      return request
    }

    /**
     * Reports whether a list request still owns the observable list state.
     *
     * @param token - Token assigned when the request started.
     * @returns Whether the request may still change the list.
     */
    function isListRequestOwned(token: number): boolean {
      return activeListRequest?.token === token
    }

    /**
     * Reads the first page of the current search query.
     *
     * @returns A promise resolving after this request ends or is superseded.
     */
    async function loadConversations(): Promise<void> {
      const request = startListRequest()
      const query = buildConversationListQuery(get().searchQuery, null)
      const listedAt = dependencies.getCurrentTimestamp()
      set({ list: { status: "loading" } })

      try {
        const response = await dependencies.listConversations(query, {
          signal: request.abortController.signal
        })
        if (!isListRequestOwned(request.token)) return

        activeListRequest = undefined
        set({
          list: {
            status: "loaded",
            page: createConversationHistoryPage(response, listedAt)
          }
        })
      } catch (error) {
        if (!isListRequestOwned(request.token)) return

        activeListRequest = undefined
        set({
          list: {
            status: "failed",
            error: formatConversationErrorMessage(error)
          }
        })
      }
    }

    /**
     * Appends the next page to the loaded conversations.
     *
     * @returns A promise resolving after this request ends or is superseded.
     * @remarks Does nothing unless a loaded page reports a further page.
     */
    async function loadNextConversationPage(): Promise<void> {
      const list = get().list
      if (list.status !== "loaded" || list.page.nextCursor === null) return

      const page = list.page
      const request = startListRequest()
      const query = buildConversationListQuery(
        get().searchQuery,
        page.nextCursor
      )
      set({ list: { status: "loading-next-page", page } })

      try {
        const response = await dependencies.listConversations(query, {
          signal: request.abortController.signal
        })
        if (!isListRequestOwned(request.token)) return

        activeListRequest = undefined
        set({
          list: {
            status: "loaded",
            page: appendConversationHistoryPage(page, response)
          }
        })
      } catch (error) {
        if (!isListRequestOwned(request.token)) return

        activeListRequest = undefined
        set({
          list: {
            status: "next-page-failed",
            page,
            error: formatConversationErrorMessage(error)
          }
        })
      }
    }

    /** Presents the panel and reloads the current search query. */
    function openHistoryPanel(): void {
      cancelListWork()
      set({ isPanelOpen: true, operation: { status: "idle" } })
      void loadConversations()
    }

    /** Hides the panel and abandons every scheduled or running list request. */
    function closeHistoryPanel(): void {
      cancelListWork()
      set({ isPanelOpen: false, operation: { status: "idle" } })
    }

    /**
     * Replaces the search text and defers a reload until typing pauses.
     *
     * @param searchQuery - Exact text currently entered in the search field.
     */
    function setSearchQuery(searchQuery: string): void {
      cancelScheduledSearch?.()
      set({ searchQuery })
      cancelScheduledSearch = dependencies.scheduleConversationSearch(() => {
        cancelScheduledSearch = undefined
        void loadConversations()
      })
    }

    /**
     * Reports whether a new conversation operation may start.
     *
     * @returns Whether no conversation operation is currently running.
     */
    function canStartOperation(): boolean {
      const status = get().operation.status

      return status === "idle" || status === "failed"
    }

    /**
     * Records the failure of the conversation operation that just ran.
     *
     * @param error - Value thrown by the failed operation.
     */
    function updateOperationFailure(error: unknown): void {
      set({
        operation: {
          status: "failed",
          error: formatConversationErrorMessage(error)
        }
      })
    }

    /**
     * Applies one change to the conversations already loaded.
     *
     * @param updatePage - Calculates the replacement page from the loaded one.
     * @returns The changed list state, or an instruction to read it again.
     * @remarks A change is applied only to a settled page, so a list request
     * that is still running can never republish pre-change conversations.
     */
    function updateLoadedConversationPage(
      updatePage: (page: ConversationHistoryPage) => ConversationHistoryPage
    ): LoadedConversationPageUpdate {
      const list = get().list
      if (list.status !== "loaded") return { status: "not-applicable" }

      return {
        status: "applied",
        list: { status: "loaded", page: updatePage(list.page) }
      }
    }

    /**
     * Settles one succeeded operation together with its list consequence.
     *
     * @param update - Outcome of applying the change to the loaded page.
     * @remarks Reads the list again when the change could not be applied, so
     * the panel never keeps conversations the backend no longer reports.
     */
    function settleSucceededOperation(
      update: LoadedConversationPageUpdate
    ): void {
      if (update.status === "applied") {
        set({ operation: { status: "idle" }, list: update.list })

        return
      }

      set({ operation: { status: "idle" } })
      void loadConversations()
    }

    /**
     * Persists a replacement title for one listed conversation.
     *
     * @param conversationId - Conversation being renamed.
     * @param title - Replacement title, which must be non-empty once trimmed.
     * @returns The outcome of this rename request.
     * @remarks Rejected while another conversation operation is running and
     * when the title is blank once trimmed.
     */
    async function updateConversationTitle(
      conversationId: string,
      title: string
    ): Promise<ConversationOperationOutcome> {
      const trimmedTitle = title.trim()
      if (!canStartOperation() || trimmedTitle === "") return "rejected"

      set({ operation: { status: "renaming", conversationId } })

      try {
        const renamedConversation = await dependencies.updateConversationTitle(
          conversationId,
          trimmedTitle
        )
        const persistedTitle = renamedConversation.title
        if (persistedTitle === null) {
          throw new Error(
            "The renamed conversation was persisted without a title"
          )
        }

        dependencies.updateChatConversationTitle(conversationId, persistedTitle)
        settleSucceededOperation(
          updateLoadedConversationPage((page) =>
            updateConversationHistoryPageTitle(page, renamedConversation)
          )
        )

        return "succeeded"
      } catch (error) {
        updateOperationFailure(error)

        return "failed"
      }
    }

    /**
     * Permanently deletes one listed conversation.
     *
     * @param conversationId - Conversation being removed.
     * @returns The outcome of this deletion request.
     * @remarks Rejected while another conversation operation is running.
     */
    async function deleteConversation(
      conversationId: string
    ): Promise<ConversationOperationOutcome> {
      if (!canStartOperation()) return "rejected"

      set({ operation: { status: "deleting", conversationId } })

      try {
        await dependencies.deleteConversation(conversationId)

        dependencies.closeChatConversation(conversationId)
        settleSucceededOperation(
          updateLoadedConversationPage((page) =>
            removeConversationFromHistoryPage(page, conversationId)
          )
        )

        return "succeeded"
      } catch (error) {
        updateOperationFailure(error)

        return "failed"
      }
    }

    /**
     * Opens one listed conversation in the chat view and hides the panel.
     *
     * @param conversationId - Conversation to continue.
     * @returns The outcome of this open request.
     * @remarks Rejected while another conversation operation is running. The
     * panel stays open when reading the conversation fails.
     */
    async function openConversation(
      conversationId: string
    ): Promise<ConversationOperationOutcome> {
      if (!canStartOperation()) return "rejected"

      set({ operation: { status: "opening", conversationId } })

      try {
        const conversation = await dependencies.getConversation(conversationId)

        dependencies.openChatConversation(conversation)
        dependencies.openChatView()
        closeHistoryPanel()

        return "succeeded"
      } catch (error) {
        updateOperationFailure(error)

        return "failed"
      }
    }

    return {
      ...INITIAL_CONVERSATION_HISTORY_STATE,
      openHistoryPanel,
      closeHistoryPanel,
      setSearchQuery,
      loadConversations,
      loadNextConversationPage,
      updateConversationTitle,
      deleteConversation,
      openConversation
    }
  }

  return create<ConversationHistoryStore>(createConversationHistoryStoreState)
}

/**
 * Defers one search reload until the user pauses typing.
 *
 * @param reloadConversations - Reload to run once the quiet period elapses.
 * @returns A canceller that prevents the deferred reload from running.
 */
function scheduleConversationSearch(
  reloadConversations: () => void
): CancelScheduledConversationSearch {
  const timer = setTimeout(reloadConversations, CONVERSATION_SEARCH_DEBOUNCE_MS)

  return () => {
    clearTimeout(timer)
  }
}

/** Conversation history store used by the desktop React tree. */
export const useConversationHistoryStore: UseBoundStore<
  StoreApi<ConversationHistoryStore>
> = createConversationHistoryStore({
  listConversations,
  getConversation,
  updateConversationTitle,
  deleteConversation,
  openChatConversation: (conversation) => {
    useChatViewStore.getState().openConversation(conversation)
  },
  openChatView: () => {
    useLysStore.getState().setActiveView("chat")
  },
  closeChatConversation: (conversationId) => {
    useChatViewStore.getState().closeConversation(conversationId)
  },
  updateChatConversationTitle: (conversationId, title) => {
    useChatViewStore
      .getState()
      .updateActiveConversationTitle(conversationId, title)
  },
  getCurrentTimestamp: () => Date.now(),
  scheduleConversationSearch
})
