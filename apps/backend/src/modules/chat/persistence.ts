import type {
  Conversation,
  ConversationAssistantMessage,
  ConversationAssistantMessageFinishReason,
  ConversationUserMessage
} from "@lys/share"

/** Inputs for atomically creating one persisted user/assistant pair. */
export type CreateConversationTurnOptions = Readonly<{
  /** Existing UUIDv7; omission creates a conversation. */
  conversationId?: string | undefined
  /** Nonempty user content appended once to the transcript. */
  userMessageContent: string
  /** Nonempty model identity stored on the assistant reply. */
  model: string
  /** Startup-loaded prompt persisted only with a conversation this turn creates. */
  systemPrompt: string
}>

/** Immutable turn identities plus an independent snapshot of the earlier transcript. */
export type ConversationTurn = Readonly<{
  /** Snapshot before this turn, including the saved system prompt. */
  conversation: Conversation
  /** User message committed with this turn. */
  userMessage: ConversationUserMessage
  /** Empty streaming reply committed with this turn. */
  assistantMessage: ConversationAssistantMessage
  /** Whether this operation created the conversation. */
  isNewConversation: boolean
}>

/** Valid terminal assistant state; only completed replies carry a finish reason. */
export type AssistantMessageCompletion =
  | Readonly<{
      /** The upstream supplied a supported completion reason. */
      status: "completed"
      /** Supported terminal model reason. */
      finishReason: ConversationAssistantMessageFinishReason
    }>
  | Readonly<{
      /** Cancellation preserves partial content; failure is retained but excluded from context. */
      status: "interrupted" | "failed"
    }>

/** Synchronous turn writes borrowed until the backend store closes; no cleanup authority. */
export interface ConversationTurnWriter {
  /**
   * Atomically creates a complete user/assistant pair and any new parent conversation.
   * @param options - Conversation selection and validated message inputs.
   * @returns Independent prior transcript and newly committed pair.
   * @throws If the target is absent, validation fails, or persistence is closed/unavailable; no partial turn remains.
   * @remarks The new turn supersedes a reply still streaming in the same
   * conversation: that reply becomes interrupted with its text retained, and
   * later writes for it return false.
   */
  createConversationTurn(
    options: CreateConversationTurnOptions
  ): ConversationTurn
  /**
   * Appends a nonempty delta before it is sent to the reply's followers.
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
