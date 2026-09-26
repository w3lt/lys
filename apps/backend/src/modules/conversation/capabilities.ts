import type { Conversation, ConversationMetadata } from "@lys/share"
import type { ListConversationsApiResponse } from "@lys/protocol"
import type { ConversationListOptions } from "../../di/services/conversationService/utils"

/** Synchronous read access borrowed for one backend lifetime; calls after closure fail. */
export interface ConversationReader {
  /**
   * Reads an independent complete transcript snapshot.
   * @param conversationId - Validated UUIDv7 target.
   * @returns The conversation or undefined when absent.
   * @throws If persistence is unavailable, closed, or contains invalid data.
   */
  getConversation(conversationId: string): Conversation | undefined
}

/** Synchronous list access borrowed from the backend persistence owner. */
export interface ConversationLister {
  /**
   * Reads counts and a page from one store snapshot.
   * @param options - Validated cursor-bound query and bounded page size.
   * @returns The strict page ordered by descending activity and UUID.
   * @throws If persistence is unavailable, closed, or contains invalid data.
   */
  listConversations(
    options: ConversationListOptions
  ): ListConversationsApiResponse
}

/** Synchronous title editing borrowed from the backend persistence owner. */
export interface ConversationTitleEditor {
  /**
   * Replaces a title without changing conversation activity time.
   * @param conversationId - Validated UUIDv7 target.
   * @param title - Candidate title, trimmed and validated using the shared API rules.
   * @returns Independent updated metadata or undefined when absent.
   * @throws If validation or persistence fails, including after owner closure.
   */
  updateConversationTitle(
    conversationId: string,
    title: string
  ): ConversationMetadata | undefined
}

/** Synchronous deletion borrowed from the backend persistence owner. */
export interface ConversationDeleter {
  /**
   * Permanently removes a conversation and all its messages before returning.
   * @param conversationId - Validated UUIDv7 target.
   * @returns True if removed; false if already absent. Repetition does not recreate data.
   * @throws If persistence fails, including after owner closure.
   */
  deleteConversation(conversationId: string): boolean
}
