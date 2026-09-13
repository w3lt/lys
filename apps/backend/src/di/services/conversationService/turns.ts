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
import { lysSystemPrompt } from "../../../utils/prompts"

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
   * Retains guarded access without database effects.
   * @param getDatabase - Borrowed access from the owning store.
   */
  public constructor(getDatabase: GetConversationDatabase) {
    this.#getDatabase = getDatabase
  }

  /**
   * Atomically selects or creates a conversation and appends a user/assistant pair.
   * @param options - Target conversation and initial message values.
   * @returns An independent snapshot and pair after the whole transaction commits.
   * @throws If lookup, validation, or persistence fails; no partial turn remains.
   */
  public createConversationTurn(
    options: CreateConversationTurnOptions
  ): ConversationTurn {
    const database = this.#getDatabase()
    const systemPrompt =
      options.conversationId === undefined ? lysSystemPrompt() : ""
    database.exec("BEGIN IMMEDIATE")
    try {
      const turn = createConversationTurn(database, options, systemPrompt)
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
   */
  public updateAssistantMessageContent(
    assistantMessageId: string,
    content: string
  ): boolean {
    const database = this.#getDatabase()
    if (content.length === 0)
      throw new Error("Assistant delta must not be empty")
    return (
      database
        .prepare(
          `UPDATE conversation_messages SET content = content || ?, updated_at = ?
      WHERE id = ? AND role = 'assistant' AND status = 'streaming'`
        )
        .run(content, new Date().toISOString(), assistantMessageId).changes ===
      1
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
