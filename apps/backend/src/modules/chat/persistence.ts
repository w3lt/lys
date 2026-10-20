import type {
  Conversation,
  ConversationAssistantMessage,
  ConversationUserMessage,
  ReplyPart,
  ToolCallReplyPart
} from "@lys/share"
import type { AssistantMessageCompletion } from "../agent/agent"
import type {
  ReplyPartDraft,
  ReplyToolCallChange
} from "../agent/replyPartSequence"

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
  /** Streaming reply without parts committed with this turn. */
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
   * conversation: that reply becomes interrupted with its stored parts kept
   * and its waiting and running calls interrupted, and later writes for it
   * return false.
   */
  createConversationTurn(
    options: CreateConversationTurnOptions
  ): ConversationTurn
  /**
   * Finalizes a streaming reply once while retaining all its persisted parts.
   * @param assistantMessageId - Streaming reply UUIDv7.
   * @param completion - Coupled terminal state and supported finish reason.
   * @returns False after deletion or prior finalization; otherwise true after persistence.
   * @throws If persistence fails, including after store closure.
   * @remarks The reply's tool calls still waiting for approval or running
   * become interrupted in the same write.
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

/**
 * Stores the parts of a streaming reply before they are sent to its
 * followers, for the chat route that lends them to the reply's agent.
 *
 * @remarks Each call reads the current time once and stores it with the part
 * or change. A reply that is finalized, superseded, or deleted refuses every
 * write through an undefined result. Borrowed until the backend store closes;
 * no cleanup authority. Concurrency model: single-owner, synchronous on the
 * backend's event loop.
 */
export interface ReplyPartWriter {
  /**
   * Stores a new part after the reply's last one.
   * @param assistantMessageId - Streaming reply UUIDv7.
   * @param draft - The part; a reasoning or text part gets a new UUIDv7.
   * @returns The stored part with its identity and times, or undefined when
   * the reply is no longer streaming.
   * @throws If the draft is invalid, such as empty text (before any storage
   * work), or persistence fails.
   */
  createReplyPart(
    assistantMessageId: string,
    draft: ReplyPartDraft
  ): ReplyPart | undefined
  /**
   * Appends a fragment to one of the reply's reasoning or text parts.
   * @param assistantMessageId - Streaming reply UUIDv7.
   * @param partId - UUIDv7 of the reply's reasoning or text part.
   * @param content - Non-empty fragment in stream order.
   * @returns The time stored as the part's `updatedAt`, or undefined when the
   * reply is no longer streaming or the part is not one of its reasoning or
   * text parts.
   * @throws If the fragment is empty (before any storage work) or
   * persistence fails.
   */
  updateReplyPartContent(
    assistantMessageId: string,
    partId: string,
    content: string
  ): string | undefined
  /**
   * Stores one change of one of the reply's tool calls, and a succeeded
   * call's sources in its conversation.
   * @param assistantMessageId - Streaming reply UUIDv7.
   * @param toolCallId - UUIDv7 of the call.
   * @param change - The call's next state.
   * @returns The call as stored, or undefined when the reply is no longer
   * streaming or the call is not in the state the change follows.
   * @throws If persistence fails, including when the conversation stores a
   * source's number for another URL or its URL under another number.
   */
  updateReplyToolCall(
    assistantMessageId: string,
    toolCallId: string,
    change: ReplyToolCallChange
  ): ToolCallReplyPart | undefined
}
