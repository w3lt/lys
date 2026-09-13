import type {
  ConversationAssistantMessageFinishReason,
  ConversationAssistantMessageStatus,
  ConversationMetadata
} from "@lys/share"
import type { PathLike } from "node:fs"
import type { ConversationListCursor } from "./utils"

/** Optional, untrusted inputs for one conversation metadata page query. */
export type ListConversationMetadataOptions = {
  /** Optional text carried into the opaque cursor; the current SQL is unfiltered. */
  query?: string
  /** Opaque cursor returned by a previous page for the same query. */
  cursor?: string
  /** Requested page size, defaulting to the service's inclusive lower bound. */
  limit?: number
}

/** Validated conversation metadata page options used by SQLite queries. */
export type VerifiedListConversationMetadataOptions = {
  /** Normalized query text bound to the cursor and current metadata request. */
  query: string
  /** Decoded cursor, or `undefined` when listing from the first page. */
  cursor: ConversationListCursor | undefined
  /** Integer page size after applying the default and maximum bounds. */
  limit: number
}

/** One conversation metadata page and its keyset-pagination state. */
export type ListConversationMetadataResult = {
  /** Metadata rows in descending updated-time and ID order. */
  conversations: ConversationMetadata[]
  /** Total number of stored conversations, independent of the query text. */
  total: number
  /** Opaque cursor for the next page, or `null` when the page is terminal. */
  nextCursor: string | null
  /** Whether another page exists beyond the returned rows. */
  hasNextPage: boolean
}

/** Filesystem location used to open the conversation SQLite database. */
export type ConversationServiceCreationOptions = {
  /** Path passed to SQLite when the service opens its owned database. */
  databaseFilePath: PathLike
}

/** Values used when creating a new conversation record. */
export type ConversationCreationOptions = {
  /** Non-empty system prompt persisted with the conversation. */
  systemPrompt: string
}

/** Identifier used to retrieve one conversation metadata record. */
export type GetConversationMetadataOptions = {
  /** UUIDv7 of the conversation to retrieve. */
  id: string
}

/** Values used to append a user-authored message to a conversation. */
export type AddUserMessageToConversationOptions = {
  /** UUIDv7 of the target conversation. */
  conversationId: string
  /** Non-empty authored message content validated by the persistence schema. */
  userMessageContent: string
}

/** Values used to append an assistant message with its initial lifecycle state. */
export type AddAssistantMessageToConversationOptions = {
  /** UUIDv7 of the target conversation. */
  conversationId: string
  /** Assistant content, which may be empty while streaming. */
  assistantMessageContent: string
  /** Non-empty model identifier associated with generation. */
  model: string
  /** Initial assistant lifecycle state persisted with the message. */
  status: ConversationAssistantMessageStatus
  /** Terminal completion reason, when the initial state is completed. */
  finishReason?: ConversationAssistantMessageFinishReason
}

/** Optional lifecycle fields used to update one persisted assistant message. */
export type UpdateAssistantMessageStateOptions = {
  /** UUIDv7 of the assistant message to update. */
  assistantMessageId: string
  /** Replacement status; omission leaves the current status unchanged. */
  status?: ConversationAssistantMessageStatus | undefined
  /** Replacement finish reason; omission leaves it unchanged and `null` clears it. */
  finishReason?: ConversationAssistantMessageFinishReason | null | undefined
}

/** Values used to replace a persisted conversation title after normalization. */
export type UpdateConversationTitleOptions = {
  /** UUIDv7 of the conversation to update. */
  conversationId: string
  /** Candidate title trimmed and rejected when empty by the service. */
  conversationTitle: string
}

/**
 * Default JavaScript-number row count for one conversation metadata page.
 *
 * @remarks This count is applied as the SQL `LIMIT`; it is not persisted or
 * transmitted. The value is stable across compatible releases unless a
 * coordinated API contract change updates the default page shape and cursor
 * behavior.
 */
export const DEFAULT_CONVERSAION_LIST_LIMIT = 1
/**
 * Inclusive maximum JavaScript-number row count accepted for one metadata page.
 *
 * @remarks This count is used for request validation and SQL `LIMIT`; it is
 * not persisted or transmitted. The value is stable across compatible
 * releases unless a coordinated compatibility change updates accepted page
 * sizes and pagination behavior.
 */
export const MAXIMUM_CONVERSATION_LIST_LIMIT = 50
