import type {
  Conversation,
  ConversationAssistantMessage,
  ConversationUserMessage
} from "@lys/share"
import type { AssistantMessageCompletion } from "../agent/agent"

/** Conversation a turn starts or continues, selected by `kind`. */
export type ConversationTurnTarget =
  | Readonly<{
      /** The turn creates a conversation. */
      kind: "new"
      /** Valid code of the agent that answers the new conversation. */
      agentCode: string
    }>
  | Readonly<{
      /** The turn continues a stored conversation, which keeps its agent. */
      kind: "existing"
      /** UUIDv7 of the stored conversation. */
      id: string
    }>

/** Inputs for atomically creating one persisted user/assistant pair. */
export type CreateConversationTurnOptions = Readonly<{
  /** Conversation the turn starts or continues. */
  conversation: ConversationTurnTarget
  /** Nonempty user content appended once to the transcript. */
  userMessageContent: string
  /** Nonempty model identity stored on the assistant reply. */
  model: string
}>

/** Immutable turn identities plus an independent snapshot of the earlier transcript. */
export type ConversationTurn = Readonly<{
  /** Snapshot before this turn, including the code of its agent. */
  conversation: Conversation
  /** User message committed with this turn. */
  userMessage: ConversationUserMessage
  /** Empty streaming reply committed with this turn. */
  assistantMessage: ConversationAssistantMessage
  /** Whether this operation created the conversation. */
  isNewConversation: boolean
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
