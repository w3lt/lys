import type { StatementSync } from "node:sqlite"
import type {
  ConversationTurnWriter,
  GeneratedConversationTitleWriter
} from "../../../modules/chat/chat/persistence"
import { handleConversationTransactionFailure } from "./transactionFailure"
import type { GetConversationDatabase } from "."
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
 * Borrows guarded SQLite access to persist atomic turns and their generation lifecycle.
 * @remarks Single-owner synchronous calls; the root store exclusively owns cleanup.
 * Deleted rows and terminal replies reject late writes through false return values.
 */
export default class SqliteConversationTurns
  implements ConversationTurnWriter, GeneratedConversationTitleWriter
{
  /** Borrowed guarded database access, valid only for the root store's lifetime. */
  readonly #getDatabase: GetConversationDatabase
  /**
   * Delta append prepared once on the store's connection. It is derived from
   * that connection, is finalized when the store closes it, and is used only
   * after `#getDatabase` confirms the store is open.
   */
  readonly #updateAssistantMessageContentStatement: StatementSync

  /**
   * Retains guarded access and an already prepared delta statement.
   * @param getDatabase - Borrowed access from the owning store.
   * @param updateAssistantMessageContentStatement - Statement prepared by
   * {@link SqliteConversationTurns.open} on the same connection.
   */
  private constructor(
    getDatabase: GetConversationDatabase,
    updateAssistantMessageContentStatement: StatementSync
  ) {
    this.#getDatabase = getDatabase
    this.#updateAssistantMessageContentStatement =
      updateAssistantMessageContentStatement
  }

  /**
   * Opens turn access on the store's connection, preparing the per-delta
   * statement once.
   * @param getDatabase - Borrowed guarded access from the owning store.
   * @returns Turn access valid until the store is disposed; it cannot release
   * the store.
   * @throws If the store is closed or SQLite cannot prepare the statement;
   * nothing is retained then.
   */
  public static open(
    getDatabase: GetConversationDatabase
  ): SqliteConversationTurns {
    const statement = getDatabase().prepare(
      UPDATE_ASSISTANT_MESSAGE_CONTENT_SQL
    )
    return new SqliteConversationTurns(getDatabase, statement)
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
    const database = this.#getDatabase()
    database.exec("BEGIN IMMEDIATE")
    try {
      const turn = createConversationTurn(
        database,
        options,
        options.systemPrompt
      )
      database.exec("COMMIT")
      return turn
    } catch (error) {
      return handleConversationTransactionFailure(database, error)
    }
  }

  /**
   * Appends a content delta before it is published to a stream consumer.
   * @param assistantMessageId - UUIDv7 of the streaming reply.
   * @param content - Nonempty delta received from the model.
   * @returns True if appended; false if the reply was deleted or already finalized.
   * @throws If the store is closed, content is empty, or SQLite fails.
   * @remarks Uses the statement prepared by {@link SqliteConversationTurns.open};
   * the write commits before this method returns.
   */
  public updateAssistantMessageContent(
    assistantMessageId: string,
    content: string
  ): boolean {
    // Rejects every write after the store closed, before the statement is used.
    this.#getDatabase()
    if (content.length === 0)
      throw new Error("Assistant delta must not be empty")
    return (
      this.#updateAssistantMessageContentStatement.run(
        content,
        new Date().toISOString(),
        assistantMessageId
      ).changes === 1
    )
  }

  /**
   * Commits one terminal state without changing already-finalized or deleted rows.
   * @param assistantMessageId - UUIDv7 of the streaming reply.
   * @param completion - Valid coupled status and completion reason.
   * @returns True if finalized; false when the message is no longer streaming or stored.
   * @throws If the store is closed or SQLite rejects the transition.
   */
  public updateAssistantMessageState(
    assistantMessageId: string,
    completion: AssistantMessageCompletion
  ): boolean {
    const database = this.#getDatabase()
    const finishReason =
      completion.status === "completed" ? completion.finishReason : null
    return (
      database
        .prepare(
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
   * @throws If the store is closed, title is empty, or SQLite fails.
   */
  public updateGeneratedConversationTitle(
    conversationId: string,
    title: string
  ): string | undefined {
    const database = this.#getDatabase()
    const normalizedTitle = title.trim()
    if (normalizedTitle.length === 0)
      throw new Error("Generated title must not be empty")
    const write = database
      .prepare(
        "UPDATE conversations SET title = ? WHERE id = ? AND title IS NULL"
      )
      .run(normalizedTitle, conversationId)
    return write.changes === 1 ? normalizedTitle : undefined
  }
}
