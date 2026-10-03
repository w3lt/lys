import {
  conversationMetadataSchema,
  type ConversationMetadata
} from "@lys/share"
import type { ConversationRecordEditor } from "../../../di/services/conversationService/records"
import type { DatabaseWriter } from "../databaseTransactions"

/**
 * Borrows the shared database's write transactions to apply user edits to
 * stored conversations.
 *
 * @remarks Owns no resource: the database's owner closes the connection, after
 * which every operation fails with `Database is closed`. Each call is one write
 * transaction that commits before it returns. Concurrency model: single-owner,
 * synchronous on the backend's event loop. Implements
 * {@link ConversationRecordEditor}.
 */
export default class SqliteConversationRecordEditor implements ConversationRecordEditor {
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
   * Implements {@link ConversationRecordEditor.updateConversationTitle} with
   * one `UPDATE … RETURNING` statement.
   * @param conversationId - Interface-defined identity.
   * @param title - Interface-defined title.
   * @returns The interface-defined metadata or absence.
   * @throws The interface-defined failures; the returned row is validated
   * before the rename commits, so an invalid row rolls the rename back.
   */
  public updateConversationTitle(
    conversationId: string,
    title: string
  ): ConversationMetadata | undefined {
    return this.#databaseWriter.handleDatabaseWriteRequest((statements) => {
      const row = statements
        .getStatement(
          `UPDATE conversations SET title = ? WHERE id = ?
      RETURNING id, title, system_prompt AS systemPrompt, created_at AS createdAt, updated_at AS updatedAt`
        )
        .get(title, conversationId)
      return row === undefined
        ? undefined
        : conversationMetadataSchema.parse(row)
    })
  }

  /**
   * Implements {@link ConversationRecordEditor.deleteConversation}; the
   * schema cascades the deletion to the conversation's messages.
   * @param conversationId - Interface-defined identity.
   * @returns The interface-defined deletion outcome.
   * @throws The interface-defined failures.
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
