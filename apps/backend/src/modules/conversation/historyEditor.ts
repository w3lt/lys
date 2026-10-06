import { updateConversationTitleApi } from "@lys/protocol"
import type { ConversationMetadata } from "@lys/share"
import type {
  ConversationTitleEditor,
  ConversationDeleter
} from "./capabilities"
import type { ConversationRecordEditor } from "./records"

/**
 * Retains borrowed conversation records to apply validated user edits to
 * conversation history.
 *
 * @remarks Owns no resource: the records' owner closes the store, after which
 * every operation fails with `Database is closed`. Each call is one write
 * transaction that commits before it returns. Concurrency model: single-owner,
 * synchronous on the backend's event loop.
 */
export default class StoredConversationHistoryEditor
  implements ConversationTitleEditor, ConversationDeleter
{
  /** Borrowed records for title edits and deletion. */
  readonly #recordEditor: ConversationRecordEditor

  /**
   * Retains borrowed records without writing them.
   * @param recordEditor - Conversation records lent by the composition root.
   */
  public constructor(recordEditor: ConversationRecordEditor) {
    this.#recordEditor = recordEditor
  }

  /**
   * Replaces a user title without changing activity time or transcript content.
   * @param conversationId - Validated UUIDv7 to rename.
   * @param title - Candidate title validated and trimmed by the shared API schema.
   * @returns Updated metadata, or undefined if the conversation is absent.
   * @throws If title validation (before any storage work), storage, or
   * validation of the renamed conversation fails; the stored title is then
   * unchanged.
   */
  public updateConversationTitle(
    conversationId: string,
    title: string
  ): ConversationMetadata | undefined {
    const parsed = updateConversationTitleApi.body.parse({ title })
    return this.#recordEditor.updateConversationTitle(
      conversationId,
      parsed.title
    )
  }

  /**
   * Permanently deletes a conversation and its transcript.
   * @param conversationId - Validated UUIDv7 to remove.
   * @returns True when a conversation was removed; false when already absent.
   * @throws If the store is closed or the deletion fails.
   */
  public deleteConversation(conversationId: string): boolean {
    return this.#recordEditor.deleteConversation(conversationId)
  }
}
