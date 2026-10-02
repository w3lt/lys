import { updateConversationTitleApi } from "@lys/protocol"
import type { ConversationMetadata } from "@lys/share"
import type { DatabaseWriter } from "../../../infrastructure/database/databaseTransactions"
import type {
  ConversationTitleEditor,
  ConversationDeleter
} from "../../../modules/conversation/capabilities"

/**
 * Borrows the shared database's write transactions to apply user edits to
 * conversation history.
 *
 * @remarks Owns no resource: the database's owner closes the connection, after
 * which every operation fails with `Database is closed`. Each call is one write
 * transaction that commits before it returns. Concurrency model: single-owner,
 * synchronous on the backend's event loop.
 */
export default class SqliteConversationHistoryEditor
  implements ConversationTitleEditor, ConversationDeleter
{
  /** Borrowed write transactions for title edits and deletion. */
  readonly #databaseWriter: DatabaseWriter

  /**
   * Retains borrowed write access without performing database work.
   * @param databaseWriter - Write transactions lent by the database owner.
   */
  public constructor(databaseWriter: DatabaseWriter) {
    this.#databaseWriter = databaseWriter
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
        .getStatement(
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
          .getStatement("DELETE FROM conversations WHERE id = ?")
          .run(conversationId).changes === 1
    )
  }
}
