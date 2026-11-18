import type { Conversation, ConversationMetadata } from "@lys/share"
import type { ListConversationsApiResponse } from "@lys/protocol"
import type { ReplyTarget } from "../chat/replyGenerationRegistry"
import type { ConversationListOptions } from "./listOptions"

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

/**
 * Synchronous read access to one conversation's metadata, for a consumer
 * that must not depend on its transcript, such as the routes that change a
 * conversation. Borrowed from the backend persistence owner for one backend
 * lifetime; calls after closure fail. Concurrency model: single-owner,
 * synchronous on the backend's event loop.
 */
export interface ConversationMetadataReader {
  /**
   * Reads an independent snapshot of one conversation's metadata, without
   * its transcript, and changes nothing.
   * @param conversationId - Validated UUIDv7 target.
   * @returns The metadata of a main conversation or of a job, which carries
   * its parent, its number, and its delegator; or undefined when absent. The
   * transcript is not read, so invalid stored messages do not fail the read.
   * @throws If persistence is unavailable, closed, or contains invalid
   * metadata.
   */
  getConversationMetadata(
    conversationId: string
  ): ConversationMetadata | undefined
}

/** Synchronous list access borrowed from the backend persistence owner. */
export interface ConversationLister {
  /**
   * Reads counts and a page of main conversations from one store snapshot.
   * A job is neither listed nor counted.
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

/**
 * Lists the working replies of a conversation and of every job below it,
 * which the delete route calls before the delete, in the same synchronous
 * step, because the delete removes the rows that name them; bound to the
 * delegation runtime by the composition root.
 *
 * @param conversationId - UUIDv7 of the conversation about to be deleted.
 * @returns The replies stored as streaming, the conversation's own first,
 * then those of the jobs below it, at any depth, in the order the jobs were
 * created; then the conversation's own replies whose generation still runs
 * its reply although they are not stored as streaming, such as a reply a
 * newer turn superseded. Empty when none works. For a conversation that is
 * no longer stored, only its own replies whose generation still runs the
 * reply are listed, such as those a delete still waits on.
 * @throws If the conversation store is closed or a stored identity
 * violates the conversation contract; nothing is listed then.
 */
export type ListWorkingReplies = (
  conversationId: string
) => readonly ReplyTarget[]

/**
 * Ends the work running in a deleted conversation and in its jobs, which
 * the delete route calls after the delete succeeded: cancels the generation
 * of each listed reply (its model request, the tool calls and approval
 * prompts it waits on, and its title request), forgets what is kept in
 * memory for the conversation, and waits until each cancelled generation
 * has settled; bound to the delegation runtime by the composition root.
 *
 * @param conversationId - UUIDv7 of the deleted conversation.
 * @param replies - The working replies listed right before the delete.
 * @returns A promise that resolves once every cancelled generation has
 * settled; it never rejects. A listed reply without a running generation
 * is skipped. A title request whose reply ended and stored its final state
 * before the listing is not cancelled, because that reply is not listed.
 */
export type StopDeletedReplies = (
  conversationId: string,
  replies: readonly ReplyTarget[]
) => Promise<void>
