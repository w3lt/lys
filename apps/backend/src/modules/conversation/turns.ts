import type {
  AssistantMessageCompletion,
  ConversationTurn,
  ConversationTurnWriter,
  CreateConversationTurnOptions,
  GeneratedConversationTitleWriter
} from "../chat/persistence"
import { createConversationTurn } from "./createTurn"
import type { ConversationTurnRecordWriter } from "./records"

/**
 * Retains borrowed turn records to persist atomic turns, their generation
 * lifecycle, and generated titles under the turn policy.
 *
 * @remarks Invariant: once created, no reply left by an earlier process is
 * still marked streaming. Owns no resource: the records' owner closes the
 * store, after which every operation fails with `Database is closed`. Each
 * call is one write transaction that commits before it returns. Deleted rows
 * and terminal replies reject late writes through false or undefined results.
 * Each operation reads the current time once and passes it to everything it
 * stores; nothing it calls reads the clock. Concurrency model: single-owner,
 * synchronous on the backend's event loop.
 */
export default class StoredConversationTurns
  implements ConversationTurnWriter, GeneratedConversationTitleWriter
{
  /** Borrowed records for every turn change. */
  readonly #turnRecordWriter: ConversationTurnRecordWriter

  /**
   * Retains borrowed records prepared by {@link StoredConversationTurns.create}.
   * @param turnRecordWriter - Turn records lent by the composition root.
   */
  private constructor(turnRecordWriter: ConversationTurnRecordWriter) {
    this.#turnRecordWriter = turnRecordWriter
  }

  /**
   * Settles the replies an earlier process left streaming and publishes turn
   * access.
   * @param turnRecordWriter - Turn records lent by the composition root.
   * @returns The ready turn access; it owns nothing to release.
   * @throws If the store is closed or the recovery write fails; a failed
   * recovery changes nothing.
   * @remarks Marks every reply still streaming as interrupted at the current
   * time, without changing its conversation's activity time or history order.
   * Create one instance per process, before any reply streams: a later
   * creation would also interrupt the replies streaming at that moment.
   */
  public static create(
    turnRecordWriter: ConversationTurnRecordWriter
  ): StoredConversationTurns {
    turnRecordWriter.updateAllStreamingAssistantMessagesToInterrupted(
      new Date().toISOString()
    )
    return new StoredConversationTurns(turnRecordWriter)
  }

  /**
   * Atomically selects or creates a conversation and appends a user/assistant pair.
   * @param options - Target conversation and initial message values.
   * @returns An independent snapshot and pair after the whole transaction commits.
   * @throws If lookup, validation, or persistence fails; no partial turn remains.
   * @remarks Implements {@link ConversationTurnWriter.createConversationTurn},
   * including interruption of a superseded streaming reply. Every value the
   * turn builds carries the current time.
   */
  public createConversationTurn(
    options: CreateConversationTurnOptions
  ): ConversationTurn {
    const now = new Date().toISOString()
    return this.#turnRecordWriter.handleConversationTurnWriteRequest(
      (transaction) => createConversationTurn(transaction, options, now)
    )
  }

  /**
   * Appends a content delta before it is published to a stream consumer.
   * @param assistantMessageId - UUIDv7 of the streaming reply.
   * @param content - Nonempty delta received from the model.
   * @returns True if appended; false if the reply was deleted or already finalized.
   * @throws If content is empty (before any storage work), the store is
   * closed, or the write fails.
   * @remarks Stores the current time as the reply's update time, in one write
   * transaction that commits before this method returns.
   */
  public updateAssistantMessageContent(
    assistantMessageId: string,
    content: string
  ): boolean {
    if (content.length === 0)
      throw new Error("Assistant delta must not be empty")
    return this.#turnRecordWriter.updateAssistantMessageContent({
      assistantMessageId,
      content,
      updatedAt: new Date().toISOString()
    })
  }

  /**
   * Commits one terminal state without changing already-finalized or deleted rows.
   * @param assistantMessageId - UUIDv7 of the streaming reply.
   * @param completion - Valid coupled status and completion reason.
   * @returns True if finalized; false when the message is no longer streaming or stored.
   * @throws If the store is closed or the write fails.
   * @remarks Stores the current time as the reply's update time.
   */
  public updateAssistantMessageState(
    assistantMessageId: string,
    completion: AssistantMessageCompletion
  ): boolean {
    return this.#turnRecordWriter.updateAssistantMessageState({
      assistantMessageId,
      completion,
      updatedAt: new Date().toISOString()
    })
  }

  /**
   * Assigns an automatically generated title only while the stored title is absent.
   * @param conversationId - UUIDv7 of the generation's conversation.
   * @param title - Generated text, trimmed and rejected if empty.
   * @returns The persisted title, or undefined after a rename, competing generation, or deletion.
   * @throws If title is empty (before any storage work), the store is
   * closed, or the write fails.
   */
  public updateGeneratedConversationTitle(
    conversationId: string,
    title: string
  ): string | undefined {
    const normalizedTitle = title.trim()
    if (normalizedTitle.length === 0)
      throw new Error("Generated title must not be empty")
    return this.#turnRecordWriter.updateUntitledConversationTitle(
      conversationId,
      normalizedTitle
    )
      ? normalizedTitle
      : undefined
  }
}
