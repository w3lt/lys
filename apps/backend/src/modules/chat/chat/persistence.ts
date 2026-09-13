import type {
  AssistantMessageCompletion,
  ConversationTurn,
  CreateConversationTurnOptions
} from "../../../di/services/conversationService/share"

/** Synchronous turn writes borrowed until the backend store closes; no cleanup authority. */
export interface ConversationTurnWriter {
  /**
   * Atomically creates a complete user/assistant pair and any new parent conversation.
   * @param options - Conversation selection and validated message inputs.
   * @returns Independent prior transcript and newly committed pair.
   * @throws If the target is absent, validation fails, or persistence is closed/unavailable; no partial turn remains.
   */
  createConversationTurn(
    options: CreateConversationTurnOptions
  ): ConversationTurn
  /**
   * Appends a nonempty delta before publication to the client.
   * @param assistantMessageId - Streaming reply UUIDv7.
   * @param content - Nonempty model fragment in stream order.
   * @returns False if deleted or finalized; otherwise true after persistence.
   * @throws If validation or persistence fails, including after store closure.
   */
  updateAssistantMessageContent(
    assistantMessageId: string,
    content: string
  ): boolean
  /**
   * Finalizes a streaming reply once while retaining all its persisted text.
   * @param assistantMessageId - Streaming reply UUIDv7.
   * @param completion - Coupled terminal state and supported finish reason.
   * @returns False after deletion or prior finalization; otherwise true after persistence.
   * @throws If persistence fails, including after store closure.
   */
  updateAssistantMessageState(
    assistantMessageId: string,
    completion: AssistantMessageCompletion
  ): boolean
}

/** Synchronous generated-title assignment borrowed from the backend store. */
export interface GeneratedConversationTitleWriter {
  /**
   * Assigns a generated title only while the conversation exists without a title.
   * @param conversationId - Generation's conversation UUIDv7.
   * @param title - Generated candidate, trimmed and rejected if empty.
   * @returns Saved text, or undefined after rename, competing assignment, or deletion.
   * @throws If validation or persistence fails, including after store closure.
   */
  updateGeneratedConversationTitle(
    conversationId: string,
    title: string
  ): string | undefined
}
