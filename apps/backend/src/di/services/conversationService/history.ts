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
import type { SqliteTransactions } from "../../../infrastructure/database/sqliteDatabase"
import { getConversation } from "./readConversation"
import { listConversations } from "./listConversations"
import type { ConversationListOptions } from "./utils"

/**
 * Borrows the shared SQLite database for history observation and user edits.
 * @remarks Single-owner synchronous calls; returned records are independent copies.
 * The composition root owns the database. Every call rejects after it closes.
 */
export default class SqliteConversationHistory
  implements
    ConversationReader,
    ConversationLister,
    ConversationTitleEditor,
    ConversationDeleter
{
  /** Borrowed transactional access; never carries the database's cleanup authority. */
  readonly #database: SqliteTransactions

  /**
   * Retains borrowed access without performing database work.
   * @param database - Shared database lent by the conversation store.
   */
  public constructor(database: SqliteTransactions) {
    this.#database = database
  }

  /**
   * Reads one conversation and its ordered transcript in one snapshot.
   * @param conversationId - Validated UUIDv7 to address.
   * @returns The stored conversation or undefined when absent.
   * @throws If the database is closed, SQLite fails, or stored data are invalid.
   */
  public getConversation(conversationId: string): Conversation | undefined {
    return this.#database.read((queries) =>
      getConversation(queries, conversationId)
    )
  }

  /**
   * Lists search matches and previews from one read snapshot.
   * @param options - Validated query and cursor from parseConversationListOptions.
   * @returns A strict page in descending activity-time and UUID order.
   * @throws If the database is closed, SQLite fails, or persisted rows are invalid.
   */
  public listConversations(
    options: ConversationListOptions
  ): ListConversationsApiResponse {
    return this.#database.read((queries) => listConversations(queries, options))
  }

  /**
   * Replaces a user title without changing activity time or transcript content.
   * @param conversationId - Validated UUIDv7 to rename.
   * @param title - Candidate title validated and trimmed by the shared API schema.
   * @returns Updated metadata, or undefined if the conversation is absent.
   * @throws If the database is closed, title validation fails, or persistence fails.
   * @remarks The rename commits before the returned row is validated.
   */
  public updateConversationTitle(
    conversationId: string,
    title: string
  ): ConversationMetadata | undefined {
    const row = this.#database.write((queries) => {
      const parsed = updateConversationTitleApi.body.parse({ title })
      return queries
        .prepare(
          `UPDATE conversations SET title = ? WHERE id = ?
      RETURNING id, title, system_prompt AS systemPrompt, created_at AS createdAt, updated_at AS updatedAt`
        )
        .get(parsed.title, conversationId)
    })
    return row === undefined
      ? undefined
      : updateConversationTitleApi.response.parse(row)
  }

  /**
   * Permanently deletes a conversation and its cascading transcript rows.
   * @param conversationId - Validated UUIDv7 to remove.
   * @returns True when a conversation was removed; false when already absent.
   * @throws If the database is closed or SQLite deletion fails.
   */
  public deleteConversation(conversationId: string): boolean {
    return this.#database.write(
      (queries) =>
        queries
          .prepare("DELETE FROM conversations WHERE id = ?")
          .run(conversationId).changes === 1
    )
  }
}
