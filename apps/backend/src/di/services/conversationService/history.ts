import {
  updateConversationTitleApi,
  type ListConversationsApiResponse
} from "@lys/protocol"
import type { Conversation, ConversationMetadata } from "@lys/share"
import type {
  ConversationReader,
  ConversationLister,
  ConversationTitleEditor,
  ConversationDeleter
} from "../../../modules/conversation/capabilities"
import { handleConversationTransactionFailure } from "./transactionFailure"
import type { GetConversationDatabase } from "."
import { getConversation } from "./readConversation"
import { listConversations } from "./listConversations"
import type { ConversationListOptions } from "./utils"

/**
 * Borrows a guarded SQLite lifetime for history observation and user edits.
 * @remarks Single-owner synchronous calls; returned records are independent copies.
 * The store owns cleanup. Every call rejects after that lifetime closes.
 */
export default class SqliteConversationHistory
  implements
    ConversationReader,
    ConversationLister,
    ConversationTitleEditor,
    ConversationDeleter
{
  /** Borrowed guarded access; never transfers the connection's cleanup authority. */
  readonly #getDatabase: GetConversationDatabase

  /**
   * Retains guarded access without performing database work.
   * @param getDatabase - Borrowed lifetime guard supplied by the owning store.
   */
  public constructor(getDatabase: GetConversationDatabase) {
    this.#getDatabase = getDatabase
  }

  /**
   * Reads one conversation and its ordered transcript in one snapshot.
   * @param conversationId - Validated UUIDv7 to address.
   * @returns The stored conversation or undefined when absent.
   * @throws If the store is closed, SQLite fails, or stored data are invalid.
   */
  public getConversation(conversationId: string): Conversation | undefined {
    const database = this.#getDatabase()
    database.exec("BEGIN")
    try {
      const conversation = getConversation(database, conversationId)
      database.exec("ROLLBACK")
      return conversation
    } catch (error) {
      return handleConversationTransactionFailure(database, error)
    }
  }

  /**
   * Lists search matches and previews from one read snapshot.
   * @param options - Validated query and cursor from parseConversationListOptions.
   * @returns A strict page in descending activity-time and UUID order.
   * @throws If the store is closed, SQLite fails, or persisted rows are invalid.
   */
  public listConversations(
    options: ConversationListOptions
  ): ListConversationsApiResponse {
    const database = this.#getDatabase()
    database.exec("BEGIN")
    try {
      const page = listConversations(database, options)
      database.exec("ROLLBACK")
      return page
    } catch (error) {
      return handleConversationTransactionFailure(database, error)
    }
  }

  /**
   * Replaces a user title without changing activity time or transcript content.
   * @param conversationId - Validated UUIDv7 to rename.
   * @param title - Candidate title validated and trimmed by the shared API schema.
   * @returns Updated metadata, or undefined if the conversation is absent.
   * @throws If title validation, store access, or persistence fails.
   */
  public updateConversationTitle(
    conversationId: string,
    title: string
  ): ConversationMetadata | undefined {
    const database = this.#getDatabase()
    const parsed = updateConversationTitleApi.body.parse({ title })
    const row = database
      .prepare(
        `UPDATE conversations SET title = ? WHERE id = ?
      RETURNING id, title, system_prompt AS systemPrompt, created_at AS createdAt, updated_at AS updatedAt`
      )
      .get(parsed.title, conversationId)
    return row === undefined
      ? undefined
      : updateConversationTitleApi.response.parse(row)
  }

  /**
   * Permanently deletes a conversation and its cascading transcript rows.
   * @param conversationId - Validated UUIDv7 to remove.
   * @returns True when a conversation was removed; false when already absent.
   * @throws If the store is closed or SQLite deletion fails.
   */
  public deleteConversation(conversationId: string): boolean {
    const database = this.#getDatabase()
    return (
      database
        .prepare("DELETE FROM conversations WHERE id = ?")
        .run(conversationId).changes === 1
    )
  }
}
