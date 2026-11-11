import type { ListConversationsApiResponse } from "@lys/protocol"
import type { Conversation, ConversationMetadata } from "@lys/share"
import type {
  ConversationReader,
  ConversationMetadataReader,
  ConversationLister
} from "./capabilities"
import {
  createConversationListCursor,
  type ConversationListOptions
} from "./listOptions"
import type { ConversationRecordReader } from "./records"

/**
 * Retains borrowed conversation records to serve history reads and paged
 * listings.
 *
 * @remarks Owns no resource: the records' owner closes the store, after which
 * every operation fails with `Database is closed`. Each call reads one
 * snapshot; returned records are independent copies. Concurrency model:
 * single-owner, synchronous on the backend's event loop.
 */
export default class StoredConversationHistoryReader
  implements ConversationReader, ConversationMetadataReader, ConversationLister
{
  /** Borrowed records for conversation and list reads. */
  readonly #recordReader: ConversationRecordReader

  /**
   * Retains borrowed records without reading them.
   * @param recordReader - Conversation records lent by the composition root.
   */
  public constructor(recordReader: ConversationRecordReader) {
    this.#recordReader = recordReader
  }

  /**
   * Reads one conversation and its ordered transcript in one snapshot.
   * @param conversationId - Validated UUIDv7 to address.
   * @returns The stored conversation or undefined when absent.
   * @throws If the store is closed or stored data are invalid.
   */
  public getConversation(conversationId: string): Conversation | undefined {
    return this.#recordReader.findConversation(conversationId)
  }

  /**
   * Implements {@link ConversationMetadataReader.getConversationMetadata} in
   * one snapshot of the borrowed records.
   * @param conversationId - Interface-defined identity.
   * @returns The interface-defined metadata or absence.
   * @throws The interface-defined closed and validation failures.
   */
  public getConversationMetadata(
    conversationId: string
  ): ConversationMetadata | undefined {
    return this.#recordReader.findConversationMetadata(conversationId)
  }

  /**
   * Lists the main conversations that match, with their previews, from one
   * snapshot and binds the continuation to the query. A job is never listed.
   * @param options - Validated query and cursor from parseConversationListOptions.
   * @returns A strict page in descending activity-time and UUID order; its
   * cursor continues after the last listed conversation while more match.
   * @throws If the store is closed or persisted rows are invalid.
   */
  public listConversations(
    options: ConversationListOptions
  ): ListConversationsApiResponse {
    const page = this.#recordReader.listConversations({
      query: options.query,
      after: options.cursor,
      limit: options.limit
    })
    const lastConversation = page.conversations.at(-1)
    return {
      conversations: page.conversations,
      storedCount: page.storedCount,
      matchCount: page.matchCount,
      nextCursor:
        page.hasMore && lastConversation !== undefined
          ? createConversationListCursor(options.query, lastConversation)
          : null
    }
  }
}
