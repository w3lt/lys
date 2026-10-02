import {
  updateConversationTitleApi,
  type ListConversationsApiResponse
} from "@lys/protocol"
import type { Conversation, ConversationMetadata } from "@lys/share"
import type {
  DatabaseReader,
  DatabaseWriter
} from "../../../infrastructure/database/databaseTransactions"
import type {
  ConversationReader,
  ConversationLister,
  ConversationTitleEditor,
  ConversationDeleter
} from "../../../modules/conversation/capabilities"
import { getConversation } from "./readConversation"
import { listConversations } from "./listConversations"
import type { ConversationListOptions } from "./utils"

/**
 * Borrows the shared database's transactions for history observation and user
 * edits.
 *
 * @remarks Owns no resource: the database's owner closes the connection, after
 * which every operation fails with `Database is closed`. Each call is one
 * transaction; returned records are independent copies. Concurrency model:
 * single-owner, synchronous on the backend's event loop.
 */
export default class SqliteConversationHistory
  implements
    ConversationReader,
    ConversationLister,
    ConversationTitleEditor,
    ConversationDeleter
{
  /** Borrowed read snapshots for conversation and list queries. */
  readonly #databaseReader: DatabaseReader
  /** Borrowed write transactions for title edits and deletion. */
  readonly #databaseWriter: DatabaseWriter

  /**
   * Retains borrowed database access without performing database work.
   * @param databaseReader - Read snapshots lent by the database owner.
   * @param databaseWriter - Write transactions lent by the database owner.
   */
  public constructor(
    databaseReader: DatabaseReader,
    databaseWriter: DatabaseWriter
  ) {
    this.#databaseReader = databaseReader
    this.#databaseWriter = databaseWriter
  }

  /**
   * Reads one conversation and its ordered transcript in one snapshot.
   * @param conversationId - Validated UUIDv7 to address.
   * @returns The stored conversation or undefined when absent.
   * @throws If the database is closed, SQLite fails, or stored data are invalid.
   */
  public getConversation(conversationId: string): Conversation | undefined {
    return this.#databaseReader.handleDatabaseReadRequest((statements) =>
      getConversation(statements, conversationId)
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
    return this.#databaseReader.handleDatabaseReadRequest((statements) =>
      listConversations(statements, options)
    )
  }

  /**
   * Replaces a user title without changing activity time or transcript content.
   * @param conversationId - Validated UUIDv7 to rename.
   * @param title - Candidate title validated and trimmed by the shared API schema.
   * @returns Updated metadata, or undefined if the conversation is absent.
   * @throws If title validation, database access, or persistence fails. The
   * returned row is validated after the rename commits.
   */
  public updateConversationTitle(
    conversationId: string,
    title: string
  ): ConversationMetadata | undefined {
    const parsed = updateConversationTitleApi.body.parse({ title })
    const row = this.#databaseWriter.handleDatabaseWriteRequest((statements) =>
      statements
        .createStatement(
          `UPDATE conversations SET title = ? WHERE id = ?
      RETURNING id, title, system_prompt AS systemPrompt, created_at AS createdAt, updated_at AS updatedAt`
        )
        .get(parsed.title, conversationId)
    )
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
    return this.#databaseWriter.handleDatabaseWriteRequest(
      (statements) =>
        statements
          .createStatement("DELETE FROM conversations WHERE id = ?")
          .run(conversationId).changes === 1
    )
  }
}
