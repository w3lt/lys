import type { DatabaseWriter } from "../../../infrastructure/database/databaseTransactions"
import type {
  ConversationTurnWriter,
  GeneratedConversationTitleWriter
} from "../../../modules/chat/chat/persistence"
import type {
  AssistantMessageCompletion,
  ConversationTurn,
  CreateConversationTurnOptions
} from "./share"
import { createConversationTurn } from "./createTurn"

/** Appends one delta to an assistant reply only while it is still streaming. */
const UPDATE_ASSISTANT_MESSAGE_CONTENT_SQL = `UPDATE conversation_messages SET content = content || ?, updated_at = ?
      WHERE id = ? AND role = 'assistant' AND status = 'streaming'`

/**
 * Borrows the shared database's write transactions to persist atomic turns and
 * their generation lifecycle.
 *
 * @remarks Owns no resource: the database's owner closes the connection, after
 * which every operation fails with `Database is closed`. Each call is one write
 * transaction that commits before it returns. Deleted rows and terminal replies
 * reject late writes through false return values. Concurrency model:
 * single-owner, synchronous on the backend's event loop.
 */
export default class SqliteConversationTurns
  implements ConversationTurnWriter, GeneratedConversationTitleWriter
{
  /** Borrowed write transactions for every turn change. */
  readonly #databaseWriter: DatabaseWriter

  /**
   * Retains borrowed write access without performing database work.
   * @param databaseWriter - Write transactions lent by the database owner.
   */
  public constructor(databaseWriter: DatabaseWriter) {
    this.#databaseWriter = databaseWriter
  }

  /**
   * Atomically selects or creates a conversation and appends a user/assistant pair.
   * @param options - Target conversation and initial message values.
   * @returns An independent snapshot and pair after the whole transaction commits.
   * @throws If lookup, validation, or persistence fails; no partial turn remains.
   * @remarks Implements {@link ConversationTurnWriter.createConversationTurn},
   * including interruption of a superseded streaming reply.
   */
  public createConversationTurn(
    options: CreateConversationTurnOptions
  ): ConversationTurn {
    return this.#databaseWriter.handleDatabaseWriteRequest((statements) =>
      createConversationTurn(statements, options, options.systemPrompt)
    )
  }

  /**
   * Appends a content delta before it is published to a stream consumer.
   * @param assistantMessageId - UUIDv7 of the streaming reply.
   * @param content - Nonempty delta received from the model.
   * @returns True if appended; false if the reply was deleted or already finalized.
   * @throws If content is empty (before any database work), the database is
   * closed, or SQLite fails.
   * @remarks Runs in one write transaction, which commits before this method
   * returns.
   */
  public updateAssistantMessageContent(
    assistantMessageId: string,
    content: string
  ): boolean {
    if (content.length === 0)
      throw new Error("Assistant delta must not be empty")
    return this.#databaseWriter.handleDatabaseWriteRequest(
      (statements) =>
        statements
          .createStatement(UPDATE_ASSISTANT_MESSAGE_CONTENT_SQL)
          .run(content, new Date().toISOString(), assistantMessageId)
          .changes === 1
    )
  }

  /**
   * Commits one terminal state without changing already-finalized or deleted rows.
   * @param assistantMessageId - UUIDv7 of the streaming reply.
   * @param completion - Valid coupled status and completion reason.
   * @returns True if finalized; false when the message is no longer streaming or stored.
   * @throws If the database is closed or SQLite rejects the transition.
   */
  public updateAssistantMessageState(
    assistantMessageId: string,
    completion: AssistantMessageCompletion
  ): boolean {
    const finishReason =
      completion.status === "completed" ? completion.finishReason : null
    return this.#databaseWriter.handleDatabaseWriteRequest(
      (statements) =>
        statements
          .createStatement(
            `UPDATE conversation_messages SET status = ?, finish_reason = ?, updated_at = ?
      WHERE id = ? AND role = 'assistant' AND status = 'streaming'`
          )
          .run(
            completion.status,
            finishReason,
            new Date().toISOString(),
            assistantMessageId
          ).changes === 1
    )
  }

  /**
   * Assigns an automatically generated title only while the stored title is absent.
   * @param conversationId - UUIDv7 of the generation's conversation.
   * @param title - Generated text, trimmed and rejected if empty.
   * @returns The persisted title, or undefined after a rename, competing generation, or deletion.
   * @throws If title is empty (before any database work), the database is
   * closed, or SQLite fails.
   */
  public updateGeneratedConversationTitle(
    conversationId: string,
    title: string
  ): string | undefined {
    const normalizedTitle = title.trim()
    if (normalizedTitle.length === 0)
      throw new Error("Generated title must not be empty")
    const changes = this.#databaseWriter.handleDatabaseWriteRequest(
      (statements) =>
        statements
          .createStatement(
            "UPDATE conversations SET title = ? WHERE id = ? AND title IS NULL"
          )
          .run(normalizedTitle, conversationId).changes
    )
    return changes === 1 ? normalizedTitle : undefined
  }
}
