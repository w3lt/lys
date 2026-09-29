import type {
  ListConversationsApiQuery,
  ListConversationsApiResponse
} from "@lys/protocol"
import { create, type StoreApi, type UseBoundStore } from "zustand"

import * as conversationApi from "@/lib/apis/http/conversations"
import type {
  ConversationApiConnection,
  ConversationTitleUpdate,
  DeleteConversationResult,
  UpdateConversationTitleResult
} from "@/lib/apis/http/conversations"
import { useLysStore } from "@/lib/store"
import { useChatViewStore } from "@/lib/store/chat-view"

import { parseConversationSearchQuery } from "./history-entries"
import {
  buildConversationHistoryPage,
  buildExtendedConversationHistoryPage,
  calculatePendingList,
  calculateSettledList,
  type ConversationHistoryListActivity,
  type ConversationHistoryListState,
  type ConversationHistoryPage,
  IDLE_LIST,
  IDLE_LIST_ACTIVITY,
  LOADING_OLDER_ACTIVITY,
  removeConversationHistoryEntry,
  updateConversationHistoryEntryTitle
} from "./history-list"

export {
  findTextMatch,
  parseConversationSearchQuery,
  type ConversationExcerpt,
  type ConversationHistoryEntry,
  type TextMatch
} from "./history-entries"
export type {
  ConversationHistoryListActivity,
  ConversationHistoryListState,
  ConversationHistoryPage
} from "./history-list"

/** Backend origin and availability sampled when a history request starts. */
export type ConversationHistoryBackend = {
  /** Application-owned backend origin. */
  readonly backendUrl: string
  /** Whether the backend process currently admits requests. */
  readonly isRunning: boolean
}

/**
 * Runtime dependencies used by one independently owned history store.
 *
 * @remarks The store owns its list-read token, its abort controller, the timer
 * that delays search reads, and every mutation it starts; these dependencies
 * provide only transport, backend availability, the clock, and the chat view's
 * reaction to a conversation that is no longer stored.
 */
export type ConversationHistoryStoreDependencies = {
  /** Lists one page of conversations; the store supplies its abort signal. */
  readonly listConversations: (
    query: ListConversationsApiQuery,
    connection: ConversationApiConnection
  ) => Promise<ListConversationsApiResponse>
  /** Persists one replacement title; mutations are never cancelled locally. */
  readonly updateConversationTitle: (
    update: ConversationTitleUpdate,
    connection: ConversationApiConnection
  ) => Promise<UpdateConversationTitleResult>
  /** Deletes one conversation; mutations are never cancelled locally. */
  readonly deleteConversation: (
    conversationId: string,
    connection: ConversationApiConnection
  ) => Promise<DeleteConversationResult>
  /** Samples the backend origin and whether it admits requests. */
  readonly getBackend: () => ConversationHistoryBackend
  /** Samples wall-clock time in epoch milliseconds when history opens. */
  readonly getCurrentTimeMs: () => number
  /**
   * Closes a conversation that is no longer stored in the chat view.
   *
   * @param conversationId - Deleted or missing conversation.
   * @remarks The chat view ignores the call unless it presents that
   * conversation.
   */
  readonly closeConversation: (conversationId: string) => void
}

/** Whether the history panel is shown, and the time it relates entries to. */
export type ConversationHistoryVisibility =
  | {
      /** The panel is not shown. */
      readonly status: "closed"
    }
  | {
      /** The panel is shown. */
      readonly status: "open"
      /** Epoch milliseconds, sampled on opening, that relative times use. */
      readonly openedAtMs: number
    }

/**
 * Transient interaction affecting at most one history row.
 *
 * @remarks Only one row can be edited or confirming deletion at a time;
 * starting either on another row replaces the current interaction. The
 * interaction ends when history closes, and a title still being edited is
 * saved first when it changed to a non-blank title.
 */
export type ConversationRowInteraction =
  | {
      /** No row is being edited or confirmed. */
      readonly kind: "none"
    }
  | {
      /** One row's title is being edited in place. */
      readonly kind: "editing-title"
      /** Conversation whose title is being edited. */
      readonly conversationId: string
      /** Title exactly as typed so far; seeded with the displayed title. */
      readonly draftTitle: string
    }
  | {
      /** One row is asking whether to delete its conversation. */
      readonly kind: "confirming-delete"
      /** Conversation whose deletion awaits confirmation. */
      readonly conversationId: string
    }

/** Title or deletion change requested for one listed conversation. */
export type ConversationHistoryMutation = {
  /** Conversation the change applies to. */
  readonly conversationId: string
  /** Pending change; at most one is pending per conversation. */
  readonly operation: "update-title" | "delete"
}

/**
 * Observable state of conversation history.
 *
 * @remarks The store owns panel visibility, the typed query, the list, the
 * row interaction, and pending mutations. The query survives closing so
 * reopening shows the same search. Mutations continue after the panel closes;
 * the list read and the row interaction do not.
 */
export type ConversationHistoryState = {
  /** Whether the panel is shown. */
  readonly visibility: ConversationHistoryVisibility
  /** Search text exactly as typed; its trimmed form is what is searched. */
  readonly query: string
  /** Lifecycle of the displayed conversation list. */
  readonly list: ConversationHistoryListState
  /** Row interaction in progress, including a title still being typed. */
  readonly rowInteraction: ConversationRowInteraction
  /** Mutations awaiting a backend outcome, in the order they started. */
  readonly pendingMutations: readonly ConversationHistoryMutation[]
  /** Latest mutation failure to present, or undefined when there is none. */
  readonly mutationError?: string
}

/**
 * Actions that change conversation history or read it from the backend.
 *
 * @remarks Asynchronous actions resolve after their outcome is committed or
 * after a newer read supersedes them; failures are recorded in state and never
 * rejected.
 */
export type ConversationHistoryActions = {
  /** Shows the panel and reads the first page for the current query. */
  readonly openConversationHistory: () => void
  /**
   * Hides the panel, saves a changed title still being edited, ends the row
   * interaction, and cancels any list read; mutations continue.
   */
  readonly closeConversationHistory: () => void
  /**
   * Replaces the typed query and, while shown, reads its first page once
   * typing pauses.
   */
  readonly updateConversationHistoryQuery: (query: string) => void
  /** Replaces the row interaction, ending any interaction on another row. */
  readonly updateConversationRowInteraction: (
    rowInteraction: ConversationRowInteraction
  ) => void
  /** Reads the first page for the current query, replacing any list read. */
  readonly loadConversationHistory: () => Promise<void>
  /** Reads the next older page for the displayed query. */
  readonly loadOlderConversations: () => Promise<void>
  /**
   * Reads the typed query's first page at once when its read waits for a
   * pause in typing, then finds the conversation Enter in the search opens.
   */
  readonly loadFirstConversationId: () => Promise<string | undefined>
  /** Persists a replacement title for one listed conversation. */
  readonly updateConversationTitle: (
    conversationId: string,
    title: string
  ) => Promise<void>
  /** Permanently deletes one listed conversation. */
  readonly deleteConversation: (conversationId: string) => Promise<void>
}

/** State and actions exposed by one conversation history store. */
export type ConversationHistoryStore = ConversationHistoryState &
  ConversationHistoryActions

/** List state while a page is displayed. */
type LoadedConversationHistoryList = Extract<
  ConversationHistoryListState,
  { status: "loaded" }
>

/**
 * Number of conversations requested per list page.
 *
 * @remarks Sent as the `limit` of every list request; it stays below the
 * protocol's inclusive maximum page size.
 */
const CONVERSATION_HISTORY_PAGE_SIZE = 30

/**
 * Milliseconds without another query change before a changed search is read.
 *
 * @remarks Each change while history is shown restarts the pause, so typing
 * without pausing sends one list request, after the last change. Opening
 * history, retrying, a re-read after a rename or delete, and Enter in the
 * search read at once instead and replace the delayed read; closing history
 * cancels it.
 */
const CONVERSATION_SEARCH_READ_DELAY_MS = 200

/** Failure shown when history is read while the backend is not running. */
const BACKEND_STOPPED_MESSAGE =
  "The backend is not running, so past conversations cannot be read."

/** Failure shown when a change is requested while the backend is stopped. */
const BACKEND_STOPPED_MUTATION_MESSAGE =
  "The backend is not running, so the change was not made."

/** Failure shown when a conversation being renamed is no longer stored. */
const MISSING_CONVERSATION_MESSAGE = "That conversation no longer exists."

/** Shared hidden visibility; it carries no data. */
const CLOSED_VISIBILITY: ConversationHistoryVisibility = Object.freeze({
  status: "closed"
})

/** Shared interaction for rows that are neither edited nor confirming. */
export const NO_ROW_INTERACTION: ConversationRowInteraction = Object.freeze({
  kind: "none"
})

/** Shared empty mutation list. */
const NO_PENDING_MUTATIONS: readonly ConversationHistoryMutation[] =
  Object.freeze([])

/** Initial observable state used as a fresh value by independent stores. */
const INITIAL_CONVERSATION_HISTORY_STATE: ConversationHistoryState =
  Object.freeze({
    visibility: CLOSED_VISIBILITY,
    query: "",
    list: IDLE_LIST,
    rowInteraction: NO_ROW_INTERACTION,
    pendingMutations: NO_PENDING_MUTATIONS,
    mutationError: undefined
  })

/** Store-private transport resource correlated with one list read. */
type ConversationListResource = {
  /** Token authorizing this read to commit its outcome. */
  readonly token: number
  /** Controller owned exclusively by the store. */
  readonly abortController: AbortController
}

/** Settled outcome of one title replacement. */
type TitleUpdateOutcome =
  | {
      /** The backend persisted the title. */
      readonly status: "updated"
      /** Title the backend persisted. */
      readonly title: string | null
    }
  | {
      /** The conversation is no longer stored. */
      readonly status: "missing"
    }
  | {
      /** The replacement could not be confirmed. */
      readonly status: "failed"
      /** User-presentable failure. */
      readonly error: string
    }

/** Settled outcome of one deletion. */
type DeletionOutcome =
  | {
      /** The conversation is no longer stored. */
      readonly status: "removed"
    }
  | {
      /** The deletion could not be confirmed. */
      readonly status: "failed"
      /** User-presentable failure. */
      readonly error: string
    }

/**
 * Converts an unknown value thrown by a history read into a message.
 *
 * @param error - Value thrown while reading a page.
 * @returns A non-empty, user-presentable reason.
 */
function formatHistoryReadError(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Past conversations could not be read."
}

/**
 * Converts an unknown value thrown by a mutation into a message.
 *
 * @param changeLabel - Gerund naming the failed change, such as `Renaming`.
 * @param error - Value thrown while making the change.
 * @returns A non-empty message naming the change and its reason.
 */
function formatMutationError(changeLabel: string, error: unknown): string {
  return error instanceof Error && error.message
    ? `${changeLabel} failed: ${error.message}`
    : `${changeLabel} failed.`
}

/**
 * Builds the request for the first page of a query.
 *
 * @param query - Parsed query; empty lists without searching.
 * @returns List parameters that omit the query when not searching.
 */
function buildFirstPageQuery(query: string): ListConversationsApiQuery {
  return query === ""
    ? { limit: CONVERSATION_HISTORY_PAGE_SIZE }
    : { query, limit: CONVERSATION_HISTORY_PAGE_SIZE }
}

/**
 * Builds the request for the page after a displayed page.
 *
 * @param page - Displayed page whose query the request continues.
 * @param cursor - Continuation returned with that page.
 * @returns List parameters bound to the page's query.
 */
function buildOlderPageQuery(
  page: ConversationHistoryPage,
  cursor: string
): ListConversationsApiQuery {
  return page.query === ""
    ? { cursor, limit: CONVERSATION_HISTORY_PAGE_SIZE }
    : { query: page.query, cursor, limit: CONVERSATION_HISTORY_PAGE_SIZE }
}

/**
 * Reports whether a displayed page can be extended with older entries.
 *
 * @param list - Displayed list.
 * @returns Whether no other list read is pending for it.
 */
function isListExtendable(list: LoadedConversationHistoryList): boolean {
  return (
    list.activity.status === "idle" || list.activity.status === "older-failed"
  )
}

/**
 * Builds the list with its displayed page's background activity replaced.
 *
 * @param list - Displayed list.
 * @param activity - Activity now affecting the displayed page.
 * @returns A frozen list keeping the same page.
 */
function buildListWithActivity(
  list: LoadedConversationHistoryList,
  activity: ConversationHistoryListActivity
): ConversationHistoryListState {
  return Object.freeze({ ...list, activity })
}

/**
 * Builds the list for a settled displayed page.
 *
 * @param page - Page to display.
 * @returns A frozen loaded list with idle activity.
 */
function buildLoadedList(
  page: ConversationHistoryPage
): ConversationHistoryListState {
  return Object.freeze({
    status: "loaded",
    page,
    activity: IDLE_LIST_ACTIVITY
  })
}

/**
 * Builds the list for a first page that could not be read.
 *
 * @param error - User-presentable reason.
 * @returns A frozen failed list.
 */
function buildFailedList(error: string): ConversationHistoryListState {
  return Object.freeze({ status: "failed", error })
}

/**
 * Adds one admitted mutation to the pending list.
 *
 * @param mutations - Mutations currently pending.
 * @param mutation - Newly admitted mutation.
 * @returns A frozen list ending with the new mutation.
 */
function addPendingMutation(
  mutations: readonly ConversationHistoryMutation[],
  mutation: ConversationHistoryMutation
): readonly ConversationHistoryMutation[] {
  return Object.freeze([...mutations, mutation])
}

/**
 * Removes a conversation's settled mutation from the pending list.
 *
 * @param mutations - Mutations currently pending.
 * @param conversationId - Conversation whose mutation settled.
 * @returns A frozen list without that conversation's mutation.
 */
function removePendingMutation(
  mutations: readonly ConversationHistoryMutation[],
  conversationId: string
): readonly ConversationHistoryMutation[] {
  return Object.freeze(
    mutations.filter((mutation) => mutation.conversationId !== conversationId)
  )
}

/**
 * Reports whether a conversation's deletion awaits its outcome.
 *
 * @param mutations - Mutations currently pending.
 * @param conversationId - Conversation to check.
 * @returns Whether that conversation is being deleted.
 */
function isDeletionPending(
  mutations: readonly ConversationHistoryMutation[],
  conversationId: string
): boolean {
  return mutations.some(
    (mutation) =>
      mutation.conversationId === conversationId &&
      mutation.operation === "delete"
  )
}

/**
 * Reports whether a conversation already has a pending mutation.
 *
 * @param mutations - Mutations currently pending.
 * @param conversationId - Conversation to check.
 * @returns Whether a change to that conversation awaits its outcome.
 */
function hasPendingMutation(
  mutations: readonly ConversationHistoryMutation[],
  conversationId: string
): boolean {
  return mutations.some(
    (mutation) => mutation.conversationId === conversationId
  )
}

/**
 * Creates one independently owned conversation history store.
 *
 * @param dependencies - Transport, availability, clock, and chat-view hooks.
 * @returns A Zustand hook and store API owning one history lifecycle.
 */
export function createConversationHistoryStore(
  dependencies: ConversationHistoryStoreDependencies
): UseBoundStore<StoreApi<ConversationHistoryStore>> {
  /** Next list token; tokens never authorize another store. */
  let nextListToken = 1
  /** Current store-owned list read, or absent when none is owned. */
  let activeListResource: ConversationListResource | undefined
  /** Timer that starts a delayed first-page read, or absent when none waits. */
  let delayedListReadTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * Reports whether a token still owns the list read.
   *
   * @param token - List token attempting to commit its outcome.
   * @returns Whether no newer read, close, or settlement superseded it.
   */
  function isListOwned(token: number): boolean {
    return activeListResource?.token === token
  }

  /**
   * Reports whether a first-page read waits for a pause in typing.
   *
   * @returns Whether a delayed read has neither started nor been cancelled.
   */
  function isListReadDelayed(): boolean {
    return delayedListReadTimer !== undefined
  }

  /**
   * Cancels the delayed first-page read, if one waits.
   *
   * @remarks Clearing the timer before it fires means its read never starts;
   * a read the timer already started is owned like any other list read.
   */
  function cancelDelayedListRead(): void {
    clearTimeout(delayedListReadTimer)
    delayedListReadTimer = undefined
  }

  /**
   * Starts a list read that supersedes any delayed or owned one.
   *
   * @returns The new read's resource; the superseded read is invalidated
   * before its transport is aborted.
   */
  function startListRead(): ConversationListResource {
    cancelDelayedListRead()
    const supersededResource = activeListResource
    const resource: ConversationListResource = {
      token: nextListToken,
      abortController: new AbortController()
    }
    nextListToken += 1
    activeListResource = resource
    supersededResource?.abortController.abort()

    return resource
  }

  /**
   * Cancels the delayed list read, if any, and invalidates the owned list
   * read, if any, aborting its transport.
   */
  function cancelListRead(): void {
    cancelDelayedListRead()
    const resource = activeListResource
    activeListResource = undefined
    resource?.abortController.abort()
  }

  /**
   * Lists one page while its read remains owned.
   *
   * @param query - List parameters for the page.
   * @param backendUrl - Backend origin sampled when the read started.
   * @param resource - Resource owned by this read.
   * @returns The validated page, or undefined when the read was superseded;
   * ownership is released before an owned outcome is returned.
   * @throws The failure of a read that was still owned; its ownership has
   * been released.
   */
  async function listOwnedPage(
    query: ListConversationsApiQuery,
    backendUrl: string,
    resource: ConversationListResource
  ): Promise<ListConversationsApiResponse | undefined> {
    try {
      const response = await dependencies.listConversations(query, {
        backendUrl,
        signal: resource.abortController.signal
      })
      if (!isListOwned(resource.token)) return undefined
      activeListResource = undefined

      return response
    } catch (error) {
      if (!isListOwned(resource.token)) return undefined
      activeListResource = undefined
      throw error
    }
  }

  /**
   * Saves one replacement title and reports the settled outcome.
   *
   * @param update - Conversation and trimmed replacement title.
   * @param backendUrl - Backend origin sampled when the mutation started.
   * @returns The outcome; failures are returned rather than thrown.
   */
  async function saveConversationTitle(
    update: ConversationTitleUpdate,
    backendUrl: string
  ): Promise<TitleUpdateOutcome> {
    try {
      const result = await dependencies.updateConversationTitle(update, {
        backendUrl
      })
      return result.status === "updated"
        ? { status: "updated", title: result.conversation.title }
        : { status: "missing" }
    } catch (error) {
      return {
        status: "failed",
        error: formatMutationError("Renaming", error)
      }
    }
  }

  /**
   * Deletes one stored conversation and reports the settled outcome.
   *
   * @param conversationId - Conversation to delete.
   * @param backendUrl - Backend origin sampled when the mutation started.
   * @returns The outcome; failures are returned rather than thrown.
   * @remarks The missing-conversation problem also establishes removal.
   */
  async function deleteStoredConversation(
    conversationId: string,
    backendUrl: string
  ): Promise<DeletionOutcome> {
    try {
      await dependencies.deleteConversation(conversationId, { backendUrl })
      return { status: "removed" }
    } catch (error) {
      return {
        status: "failed",
        error: formatMutationError("Deleting", error)
      }
    }
  }

  /**
   * Creates the state and actions that own this store's history lifecycle.
   *
   * @param set - Zustand capability that applies observable state changes.
   * @param get - Zustand capability that reads current observable state.
   * @returns Initial history state and its actions.
   */
  function createConversationHistoryStoreState(
    set: StoreApi<ConversationHistoryStore>["setState"],
    get: StoreApi<ConversationHistoryStore>["getState"]
  ): ConversationHistoryStore {
    /**
     * Reads the first page for the current query at once, replacing any
     * delayed or sent list read.
     *
     * @returns A promise that resolves after the page or failure commits, or
     * after a newer read, close, or settlement supersedes this one.
     * @remarks A displayed page stays visible while its replacement is read.
     * A stopped backend fails the read without sending a request.
     */
    async function loadConversationHistory(): Promise<void> {
      const query = parseConversationSearchQuery(get().query)
      const resource = startListRead()
      const backend = dependencies.getBackend()
      if (!backend.isRunning) {
        activeListResource = undefined
        set({ list: buildFailedList(BACKEND_STOPPED_MESSAGE) })
        return
      }

      set({ list: calculatePendingList(get().list) })
      try {
        const response = await listOwnedPage(
          buildFirstPageQuery(query),
          backend.backendUrl,
          resource
        )
        if (response === undefined) return
        const page = buildConversationHistoryPage(query, response)
        set({ list: buildLoadedList(page) })
      } catch (error) {
        set({ list: buildFailedList(formatHistoryReadError(error)) })
      }
    }

    /**
     * Starts a first-page read that waits for a pause in typing.
     *
     * @remarks Any delayed or sent list read is cancelled, and the list is
     * marked pending at once, as it is for an immediate read. The read starts
     * {@link CONVERSATION_SEARCH_READ_DELAY_MS} later for the query typed
     * then, unless another change, an immediate read, or closing history
     * cancels it first.
     */
    function startDelayedListRead(): void {
      cancelListRead()
      set({ list: calculatePendingList(get().list) })
      delayedListReadTimer = setTimeout(
        () => void loadConversationHistory(),
        CONVERSATION_SEARCH_READ_DELAY_MS
      )
    }

    /**
     * Reports whether a first page is being read to replace the list.
     *
     * @returns Whether a delayed or owned first-page read may still commit its
     * page.
     */
    function isFirstPageReadPending(): boolean {
      const { list } = get()
      if (list.status === "loading") return true

      return list.status === "loaded" && list.activity.status === "refreshing"
    }

    /**
     * Replaces a pending first-page read after a change to a listed
     * conversation settles.
     *
     * @remarks A read already sent may answer from before the change was
     * stored, and committing it would undo the change on screen. The
     * replacement read starts after the change settled, and a delayed read is
     * started at once rather than after its pause. Without a pending
     * first-page read, the settled change has already been applied to the
     * displayed page and nothing is read.
     */
    function loadConversationHistoryAfterMutation(): void {
      if (isFirstPageReadPending()) void loadConversationHistory()
    }

    /**
     * Updates the displayed page with an older page.
     *
     * @param response - Validated older page for the displayed query.
     */
    function updateListWithOlderPage(
      response: ListConversationsApiResponse
    ): void {
      const list = get().list
      if (list.status !== "loaded") return

      const page = buildExtendedConversationHistoryPage(list.page, response)
      set({ list: buildLoadedList(page) })
    }

    /**
     * Updates the displayed page after its older page could not be read.
     *
     * @param error - User-presentable reason.
     */
    function updateListWithOlderPageFailure(error: string): void {
      const list = get().list
      if (list.status !== "loaded") return

      const activity: ConversationHistoryListActivity = {
        status: "older-failed",
        error
      }
      set({ list: buildListWithActivity(list, activity) })
    }

    /**
     * Reads the next older page for the displayed query.
     *
     * @returns A promise that resolves after the extension or failure commits,
     * or after a newer read supersedes this one.
     * @remarks Ignored unless a page is displayed with a continuation and no
     * other list read is pending; a failure keeps the displayed entries.
     */
    async function loadOlderConversations(): Promise<void> {
      const list = get().list
      if (list.status !== "loaded" || !isListExtendable(list)) return
      const cursor = list.page.nextCursor
      if (cursor === null) return

      const resource = startListRead()
      const backend = dependencies.getBackend()
      if (!backend.isRunning) {
        activeListResource = undefined
        updateListWithOlderPageFailure(BACKEND_STOPPED_MESSAGE)
        return
      }

      set({ list: buildListWithActivity(list, LOADING_OLDER_ACTIVITY) })
      try {
        const response = await listOwnedPage(
          buildOlderPageQuery(list.page, cursor),
          backend.backendUrl,
          resource
        )
        if (response !== undefined) updateListWithOlderPage(response)
      } catch (error) {
        updateListWithOlderPageFailure(formatHistoryReadError(error))
      }
    }

    /** Shows the panel and reads the first page for the current query. */
    function openConversationHistory(): void {
      if (get().visibility.status === "open") return

      const visibility: ConversationHistoryVisibility = {
        status: "open",
        openedAtMs: dependencies.getCurrentTimeMs()
      }
      set({ visibility })
      void loadConversationHistory()
    }

    /**
     * Finds the title still being edited that closing history must save.
     *
     * @returns The trimmed title for a listed conversation when it is
     * non-blank and differs from the displayed title, otherwise undefined.
     */
    function findUnsavedTitleUpdate(): ConversationTitleUpdate | undefined {
      const { rowInteraction, list } = get()
      if (rowInteraction.kind !== "editing-title") return undefined
      if (list.status !== "loaded") return undefined
      const entry = list.page.entries.find(
        (listed) => listed.id === rowInteraction.conversationId
      )
      const title = rowInteraction.draftTitle.trim()
      if (entry === undefined || title === "" || title === entry.title)
        return undefined

      return { conversationId: entry.id, title }
    }

    /**
     * Hides the panel, ends the row interaction, cancels any list read, and
     * clears the mutation error.
     *
     * @remarks A displayed page is kept for the next opening, which reads the
     * list again. A changed, non-blank title still being edited is saved as
     * a rename that continues after closing, so its failure is shown when
     * history opens again. Pending mutations continue and commit their
     * outcomes.
     */
    function closeConversationHistory(): void {
      if (get().visibility.status === "closed") return

      const unsavedTitle = findUnsavedTitleUpdate()
      cancelListRead()
      set({
        visibility: CLOSED_VISIBILITY,
        list: calculateSettledList(get().list),
        rowInteraction: NO_ROW_INTERACTION,
        mutationError: undefined
      })
      if (unsavedTitle === undefined) return

      void updateConversationTitle(
        unsavedTitle.conversationId,
        unsavedTitle.title
      )
    }

    /**
     * Replaces the row interaction proposed by the panel.
     *
     * @param rowInteraction - Complete next interaction; starting one on a
     * row ends any interaction on another row.
     */
    function updateConversationRowInteraction(
      rowInteraction: ConversationRowInteraction
    ): void {
      set({ rowInteraction })
    }

    /**
     * Reports whether the displayed page already answers a parsed query.
     *
     * @param query - Parsed query to compare.
     * @returns Whether a settled page for exactly that query is displayed.
     */
    function isPageCurrent(query: string): boolean {
      const list = get().list
      if (list.status !== "loaded") return false

      return list.activity.status === "idle" && list.page.query === query
    }

    /**
     * Replaces the typed query and, while shown, reads its first page once
     * typing pauses.
     *
     * @param query - Search text exactly as typed.
     * @remarks No read starts when the trimmed query is the one already
     * displayed. Otherwise the change cancels any pending list read, marks the
     * list pending, and restarts the pause after which the first page is read.
     */
    function updateConversationHistoryQuery(query: string): void {
      set({ query })
      if (get().visibility.status === "closed") return
      if (isPageCurrent(parseConversationSearchQuery(query))) return

      startDelayedListRead()
    }

    /**
     * Finds the conversation Enter in the search opens.
     *
     * @returns The first displayed conversation that is not being deleted,
     * or undefined when history is closed, no displayed page answers the
     * query typed now, or every displayed conversation is being deleted.
     */
    function findFirstConversationId(): string | undefined {
      const { visibility, query, list, pendingMutations } = get()
      if (visibility.status === "closed") return undefined
      if (list.status !== "loaded") return undefined
      if (list.page.query !== parseConversationSearchQuery(query))
        return undefined

      const entry = list.page.entries.find(
        (listed) => !isDeletionPending(pendingMutations, listed.id)
      )
      return entry?.id
    }

    /**
     * Reads the typed query's first page at once when its read waits for a
     * pause in typing, then finds the conversation Enter in the search opens.
     *
     * @returns A promise resolving with the first displayed conversation that
     * is not being deleted, once any delayed read commits or is superseded;
     * undefined when history closed, the page does not answer the query typed
     * by then, or nothing listed can be opened.
     * @remarks A read already sent is not awaited; the displayed page is used
     * as it is, so nothing is found while it answers an earlier query.
     */
    async function loadFirstConversationId(): Promise<string | undefined> {
      if (isListReadDelayed()) await loadConversationHistory()

      return findFirstConversationId()
    }

    /**
     * Admits one mutation for a conversation without a pending mutation.
     *
     * @param mutation - Change to admit.
     * @returns The backend origin to use, or undefined when the mutation was
     * rejected because another is pending or the backend is stopped.
     */
    function startMutation(
      mutation: ConversationHistoryMutation
    ): string | undefined {
      const { pendingMutations } = get()
      if (hasPendingMutation(pendingMutations, mutation.conversationId))
        return undefined

      const backend = dependencies.getBackend()
      if (!backend.isRunning) {
        set({ mutationError: BACKEND_STOPPED_MUTATION_MESSAGE })
        return undefined
      }

      set({
        pendingMutations: addPendingMutation(pendingMutations, mutation),
        mutationError: undefined
      })
      return backend.backendUrl
    }

    /**
     * Updates history with the settled outcome of one title replacement.
     *
     * @param conversationId - Renamed conversation.
     * @param outcome - Settled replacement outcome.
     * @remarks A missing conversation is removed from the list and closed in
     * the chat view.
     */
    function updateHistoryWithTitleOutcome(
      conversationId: string,
      outcome: TitleUpdateOutcome
    ): void {
      const { list, pendingMutations } = get()
      const remainingMutations = removePendingMutation(
        pendingMutations,
        conversationId
      )
      switch (outcome.status) {
        case "updated":
          set({
            list: updateConversationHistoryEntryTitle(
              list,
              conversationId,
              outcome.title
            ),
            pendingMutations: remainingMutations
          })
          return
        case "missing":
          set({
            list: removeConversationHistoryEntry(list, conversationId),
            pendingMutations: remainingMutations,
            mutationError: MISSING_CONVERSATION_MESSAGE
          })
          dependencies.closeConversation(conversationId)
          return
        case "failed":
          set({
            pendingMutations: remainingMutations,
            mutationError: outcome.error
          })
          return
      }
    }

    /**
     * Persists a replacement title for one listed conversation.
     *
     * @param conversationId - Conversation to rename.
     * @param title - Candidate title; surrounding whitespace is removed.
     * @returns A promise that resolves after the outcome commits.
     * @remarks Ignored for an empty title or while the conversation has a
     * pending mutation. The renamed entry keeps its position. A first-page
     * read pending when the rename settles is replaced by a new read.
     */
    async function updateConversationTitle(
      conversationId: string,
      title: string
    ): Promise<void> {
      const trimmedTitle = title.trim()
      if (trimmedTitle === "") return

      const backendUrl = startMutation({
        conversationId,
        operation: "update-title"
      })
      if (backendUrl === undefined) return

      const outcome = await saveConversationTitle(
        { conversationId, title: trimmedTitle },
        backendUrl
      )
      updateHistoryWithTitleOutcome(conversationId, outcome)
      if (outcome.status !== "failed") loadConversationHistoryAfterMutation()
    }

    /**
     * Permanently deletes one listed conversation.
     *
     * @param conversationId - Conversation to delete.
     * @returns A promise that resolves after the outcome commits.
     * @remarks Ignored while the conversation has a pending mutation. Once the
     * conversation is no longer stored, its entry is removed, the chat view
     * closes it if presented, and a first-page read still pending is replaced
     * by a new read; a failure keeps the entry.
     */
    async function deleteConversation(conversationId: string): Promise<void> {
      const backendUrl = startMutation({ conversationId, operation: "delete" })
      if (backendUrl === undefined) return

      const outcome = await deleteStoredConversation(conversationId, backendUrl)
      const { list, pendingMutations } = get()
      const remainingMutations = removePendingMutation(
        pendingMutations,
        conversationId
      )
      if (outcome.status === "failed") {
        set({
          pendingMutations: remainingMutations,
          mutationError: outcome.error
        })
        return
      }

      set({
        list: removeConversationHistoryEntry(list, conversationId),
        pendingMutations: remainingMutations
      })
      dependencies.closeConversation(conversationId)
      loadConversationHistoryAfterMutation()
    }

    return {
      ...INITIAL_CONVERSATION_HISTORY_STATE,
      openConversationHistory,
      closeConversationHistory,
      updateConversationHistoryQuery,
      updateConversationRowInteraction,
      loadConversationHistory,
      loadOlderConversations,
      loadFirstConversationId,
      updateConversationTitle,
      deleteConversation
    }
  }

  return create<ConversationHistoryStore>(createConversationHistoryStoreState)
}

/**
 * Samples the backend origin and availability from the application store.
 *
 * @returns The current origin and whether the backend process is running.
 */
function getApplicationBackend(): ConversationHistoryBackend {
  const { backendUrl, backendServerInfo } = useLysStore.getState()

  return { backendUrl, isRunning: backendServerInfo.status === "running" }
}

/**
 * Closes a conversation that is no longer stored in the chat view.
 *
 * @param conversationId - Deleted or missing conversation.
 */
function closeChatViewConversation(conversationId: string): void {
  useChatViewStore.getState().closeConversation(conversationId)
}

/**
 * Conversation history store used by the desktop React tree.
 *
 * @remarks This singleton reads history from the backend named by the
 * application store and tells the chat-view store when a conversation it may
 * present is no longer stored. Tests or alternate compositions should call
 * {@link createConversationHistoryStore} to obtain a separate owner.
 */
export const useConversationHistoryStore: UseBoundStore<
  StoreApi<ConversationHistoryStore>
> = createConversationHistoryStore({
  listConversations: conversationApi.listConversations,
  updateConversationTitle: conversationApi.updateConversationTitle,
  deleteConversation: conversationApi.deleteConversation,
  getBackend: getApplicationBackend,
  getCurrentTimeMs: () => Date.now(),
  closeConversation: closeChatViewConversation
})
