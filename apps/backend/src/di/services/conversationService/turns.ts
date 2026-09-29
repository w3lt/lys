import type {
  ConversationTurnWriter,
  GeneratedConversationTitleWriter
} from "../../../modules/chat/chat/persistence"
import type { SqliteTransactions } from "../../../infrastructure/database/sqliteDatabase"
import type {
  AssistantMessageCompletion,
  ConversationTurn,
  CreateConversationTurnOptions
} from "./share"
import { createConversationTurn } from "./createTurn"

/**
 * Borrows the shared SQLite database to persist atomic turns and their
 * generation lifecycle.
 * @remarks Single-owner synchronous calls; the composition root exclusively owns
 * cleanup. Deleted rows and terminal replies reject late writes through false
 * return values.
 */
export default class SqliteConversationTurns
  implements ConversationTurnWriter, GeneratedConversationTitleWriter
{
  /** Borrowed transactional access, valid only while the database is open. */
  readonly #database: SqliteTransactions

  /**
   * Retains borrowed access without database effects.
   * @param database - Shared database lent by the conversation store.
   */
  public constructor(database: SqliteTransactions) {
    this.#database = database
  }

  /**
   * Atomically selects or creates a conversation and appends a user/assistant pair.
   * @param options - Target conversation and initial message values.
   * @returns An independent snapshot and pair after the whole transaction commits.
   * @throws If the database is closed, or lookup, validation, or persistence
   * fails; no partial turn remains.
   * @remarks Implements {@link ConversationTurnWriter.createConversationTurn},
   * including interruption of a superseded streaming reply.
   */
  public createConversationTurn(
    options: CreateConversationTurnOptions
  ): ConversationTurn {
    return this.#database.write((queries) =>
      createConversationTurn(queries, options, options.systemPrompt)
    )
  }

  /**
   * Appends a content delta before it is published to a stream consumer.
   * @param assistantMessageId - UUIDv7 of the streaming reply.
   * @param content - Nonempty delta received from the model.
   * @returns True if appended; false if the reply was deleted or already finalized.
   * @throws If the database is closed, content is empty, or SQLite fails.
   */
  public updateAssistantMessageContent(
    assistantMessageId: string,
    content: string
  ): boolean {
    return this.#database.write((queries) => {
      if (content.length === 0)
        throw new Error("Assistant delta must not be empty")
      return (
        queries
          .prepare(
            `UPDATE conversation_messages SET content = content || ?, updated_at = ?
      WHERE id = ? AND role = 'assistant' AND status = 'streaming'`
          )
          .run(content, new Date().toISOString(), assistantMessageId)
          .changes === 1
      )
    })
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
    return this.#database.write(
      (queries) =>
        queries
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
   * @throws If the database is closed, title is empty, or SQLite fails.
   */
  public updateGeneratedConversationTitle(
    conversationId: string,
    title: string
  ): string | undefined {
    return this.#database.write((queries) => {
      const normalizedTitle = title.trim()
      if (normalizedTitle.length === 0)
        throw new Error("Generated title must not be empty")
      const write = queries
        .prepare(
          "UPDATE conversations SET title = ? WHERE id = ? AND title IS NULL"
        )
        .run(normalizedTitle, conversationId)
      return write.changes === 1 ? normalizedTitle : undefined
    })
  }
}
