import type { ListConversationsApiResponse } from "@lys/protocol"

import {
  buildConversationHistoryEntry,
  type ConversationHistoryEntry
} from "./history-entries"

/**
 * One loaded page sequence of listed conversations for one search query.
 *
 * @remarks Entries keep the backend order, newest activity first, and each
 * identifier appears once. Older pages append to `entries`; the counts and
 * cursor always come from the most recent response or local removal.
 */
export type ConversationHistoryPage = {
  /** Parsed query the entries answer; empty when not searching. */
  readonly query: string
  /** Loaded entries in backend order without duplicate identities. */
  readonly entries: readonly ConversationHistoryEntry[]
  /** Number of stored conversations, independent of the query. */
  readonly storedCount: number
  /** Number of stored conversations matching the query. */
  readonly matchCount: number
  /** Continuation for older entries of the same query, or null when complete. */
  readonly nextCursor: string | null
}

/** Background work affecting an already displayed page. */
export type ConversationHistoryListActivity =
  | {
      /** No request is replacing or extending the page. */
      readonly status: "idle"
    }
  | {
      /** A first page for the current query is replacing the displayed page. */
      readonly status: "refreshing"
    }
  | {
      /** The next older page is being read to extend the displayed page. */
      readonly status: "loading-older"
    }
  | {
      /** Reading the next older page failed; the displayed page is intact. */
      readonly status: "older-failed"
      /** User-presentable reason the older page could not be read. */
      readonly error: string
    }

/**
 * Lifecycle of the conversation list shown in the history panel.
 *
 * @remarks `refreshing` retains the previous page, which may answer an older
 * query, until the replacement arrives; consumers highlight against the
 * page's own query rather than the text being typed.
 */
export type ConversationHistoryListState =
  | {
      /** Nothing has been read since the list was last settled. */
      readonly status: "idle"
    }
  | {
      /** The first page is being read and nothing can be shown yet. */
      readonly status: "loading"
    }
  | {
      /** The first page could not be read. */
      readonly status: "failed"
      /** User-presentable reason the list could not be read. */
      readonly error: string
    }
  | {
      /** A page is displayed. */
      readonly status: "loaded"
      /** Displayed entries and continuation state. */
      readonly page: ConversationHistoryPage
      /** Work currently replacing or extending the displayed page. */
      readonly activity: ConversationHistoryListActivity
    }

/** Shared settled activity; it carries no per-request data. */
export const IDLE_LIST_ACTIVITY: ConversationHistoryListActivity =
  Object.freeze({ status: "idle" })

/** Shared never-read list; it carries no data. */
export const IDLE_LIST: ConversationHistoryListState = Object.freeze({
  status: "idle"
})

/** Shared first-read list; it carries no data. */
const LOADING_LIST: ConversationHistoryListState = Object.freeze({
  status: "loading"
})

/** Shared replacement activity; it carries no per-request data. */
const REFRESHING_ACTIVITY: ConversationHistoryListActivity = Object.freeze({
  status: "refreshing"
})

/** Shared extension activity; it carries no per-request data. */
export const LOADING_OLDER_ACTIVITY: ConversationHistoryListActivity =
  Object.freeze({ status: "loading-older" })

/**
 * Builds the page for a first-page response.
 *
 * @param query - Parsed query sent with the request.
 * @param response - Validated first page returned by the backend.
 * @returns A frozen page whose entries are projected for display.
 */
export function buildConversationHistoryPage(
  query: string,
  response: ListConversationsApiResponse
): ConversationHistoryPage {
  const entries = Object.freeze(
    response.conversations.map((summary) =>
      buildConversationHistoryEntry(summary, query)
    )
  )

  return Object.freeze({
    query,
    entries,
    storedCount: response.storedCount,
    matchCount: response.matchCount,
    nextCursor: response.nextCursor
  })
}

/**
 * Builds the page extended by an older-page response.
 *
 * @param page - Displayed page the older response continues.
 * @param response - Validated older page for the same query.
 * @returns A frozen page with new entries appended, identities already shown
 * skipped, and counts and cursor taken from the response.
 */
export function buildExtendedConversationHistoryPage(
  page: ConversationHistoryPage,
  response: ListConversationsApiResponse
): ConversationHistoryPage {
  const shownIds = new Set(page.entries.map((entry) => entry.id))
  const olderEntries = response.conversations
    .filter((summary) => !shownIds.has(summary.id))
    .map((summary) => buildConversationHistoryEntry(summary, page.query))
  const entries = Object.freeze([...page.entries, ...olderEntries])

  return Object.freeze({
    query: page.query,
    entries,
    storedCount: response.storedCount,
    matchCount: response.matchCount,
    nextCursor: response.nextCursor
  })
}

/**
 * Calculates the list while a first page for the current query is read.
 *
 * @param list - Current list state.
 * @returns The displayed page marked refreshing, or the loading state when no
 * page is displayed.
 */
export function calculatePendingList(
  list: ConversationHistoryListState
): ConversationHistoryListState {
  if (list.status !== "loaded") return LOADING_LIST

  return Object.freeze({ ...list, activity: REFRESHING_ACTIVITY })
}

/**
 * Calculates the list after its outstanding request is abandoned.
 *
 * @param list - Current list state.
 * @returns The list without pending work: a displayed page keeps its entries
 * with idle activity, and an unfinished first read returns to idle.
 */
export function calculateSettledList(
  list: ConversationHistoryListState
): ConversationHistoryListState {
  switch (list.status) {
    case "idle":
    case "failed":
      return list
    case "loading":
      return IDLE_LIST
    case "loaded":
      return list.activity.status === "idle"
        ? list
        : Object.freeze({ ...list, activity: IDLE_LIST_ACTIVITY })
  }
}

/**
 * Updates one displayed entry after its title was persisted.
 *
 * @param list - Current list state.
 * @param conversationId - Renamed conversation.
 * @param title - Title persisted by the backend.
 * @returns The list with that entry's title replaced and its position kept,
 * or the unchanged list when the entry is not displayed.
 */
export function updateConversationHistoryEntryTitle(
  list: ConversationHistoryListState,
  conversationId: string,
  title: string | null
): ConversationHistoryListState {
  if (list.status !== "loaded") return list

  const entries = Object.freeze(
    list.page.entries.map((entry) =>
      entry.id === conversationId ? Object.freeze({ ...entry, title }) : entry
    )
  )
  const page = Object.freeze({ ...list.page, entries })

  return Object.freeze({ ...list, page })
}

/**
 * Removes one displayed entry after its conversation stopped being stored.
 *
 * @param list - Current list state.
 * @param conversationId - Conversation that is no longer stored.
 * @returns The list without that entry and with both counts reduced, or the
 * unchanged list when the entry is not displayed.
 */
export function removeConversationHistoryEntry(
  list: ConversationHistoryListState,
  conversationId: string
): ConversationHistoryListState {
  if (list.status !== "loaded") return list
  if (!list.page.entries.some((entry) => entry.id === conversationId))
    return list

  const entries = Object.freeze(
    list.page.entries.filter((entry) => entry.id !== conversationId)
  )
  const page = Object.freeze({
    ...list.page,
    entries,
    storedCount: Math.max(0, list.page.storedCount - 1),
    matchCount: Math.max(0, list.page.matchCount - 1)
  })

  return Object.freeze({ ...list, page })
}
