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
}>

/** Immutable turn identities plus an independent snapshot of the earlier transcript. */
export type ConversationTurn = Readonly<{
  /** Snapshot before this turn, including the saved system prompt. */
  conversation: Conversation
  /** User row committed with this turn. */
  userMessage: ConversationUserMessage
  /** Empty streaming row committed with this turn. */
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
