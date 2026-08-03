import type { ChatApiStreamEvent } from "@lys/protocol"
import type {
  Conversation,
  ConversationAssistantMessage,
  ConversationMetadata,
  ConversationUserMessage
} from "@lys/share"

/** Inputs required to append one backend-owned turn to a conversation. */
export type StartConversationTurnOptions = {
  /** Latest metadata returned by the backend for the active conversation. */
  readonly conversationMetadata: ConversationMetadata
  /** Existing local conversation whose transcript may be preserved. */
  readonly previousConversation?: Conversation
  /** Persisted user message acknowledged by the backend. */
  readonly userMessage: ConversationUserMessage
  /** Persisted assistant message that will receive streamed content. */
  readonly assistantMessage: ConversationAssistantMessage
}

/** Inputs required to update one assistant reply with streamed content. */
export type UpdateAssistantReplyContentOptions = {
  /** Identifier of the assistant message receiving the delta. */
  readonly assistantMessageId: string
  /** Non-empty content emitted by the chat stream. */
  readonly content: string
  /** ISO timestamp applied to the updated assistant message. */
  readonly timestamp: string
}

/** Inputs required to update an assistant reply to a valid terminal state. */
export type UpdateAssistantReplyStatusOptions =
  | {
      /** Identifier of the assistant message entering a terminal state. */
      readonly assistantMessageId: string
      /** Successful model completion lifecycle state. */
      readonly status: "completed"
      /** Non-null reason reported by the completed model stream. */
      readonly finishReason: Extract<
        ChatApiStreamEvent,
        { type: "done" }
      >["finishReason"]
      /** ISO timestamp applied to the terminal assistant message. */
      readonly timestamp: string
    }
  | {
      /** Identifier of the assistant message entering a terminal state. */
      readonly assistantMessageId: string
      /** Terminal state reached without model completion. */
      readonly status: "interrupted" | "failed"
      /** Absence of a model completion reason. */
      readonly finishReason: null
      /** ISO timestamp applied to the terminal assistant message. */
      readonly timestamp: string
    }

/**
 * Combines backend metadata and messages with matching local history.
 *
 * @param options - Metadata, prior state, and the new backend-owned turn.
 * @returns A conversation containing matching history followed by the user and
 * assistant messages received from the backend.
 */
export function startConversationTurn(
  options: StartConversationTurnOptions
): Conversation {
  const previousMessages =
    options.previousConversation?.id === options.conversationMetadata.id
      ? options.previousConversation.messages
      : []
  const messages = [
    ...previousMessages,
    options.userMessage,
    options.assistantMessage
  ]

  return {
    ...options.conversationMetadata,
    messages
  }
}

/**
 * Replaces conversation metadata title without changing transcript messages.
 *
 * @param conversation - Conversation whose title is being updated.
 * @param title - Non-empty title emitted by the chat stream.
 * @returns A new conversation with the supplied title.
 */
export function updateConversationTitle(
  conversation: Conversation,
  title: string
): Conversation {
  return { ...conversation, title }
}

/**
 * Appends one delta to the assistant message owned by the active request.
 *
 * @param conversation - Conversation containing the active assistant message.
 * @param options - Assistant identifier, content, and update timestamp.
 * @returns A new conversation containing the appended assistant content.
 * @throws If the owned assistant message is absent or already terminal.
 */
export function updateAssistantReplyContent(
  conversation: Conversation,
  options: UpdateAssistantReplyContentOptions
): Conversation {
  const assistantMessage = conversation.messages.find(
    (message) => message.id === options.assistantMessageId
  )
  if (!assistantMessage || assistantMessage.role !== "assistant") {
    throw new Error(
      `Assistant message ${options.assistantMessageId} was not found`
    )
  }
  if (assistantMessage.status !== "streaming") {
    throw new Error(
      `Assistant message ${options.assistantMessageId} is already terminal`
    )
  }

  return {
    ...conversation,
    messages: conversation.messages.map((message) =>
      message.id === options.assistantMessageId
        ? {
            ...assistantMessage,
            content: assistantMessage.content + options.content,
            updatedAt: options.timestamp
          }
        : message
    )
  }
}

/**
 * Moves the owned assistant message into one terminal lifecycle state.
 *
 * @param conversation - Conversation containing the active assistant message.
 * @param options - Assistant identifier and terminal outcome.
 * @returns A new conversation containing the terminal assistant message.
 * @throws If the owned assistant message is absent or already terminal.
 */
export function updateAssistantReplyStatus(
  conversation: Conversation,
  options: UpdateAssistantReplyStatusOptions
): Conversation {
  const assistantMessage = conversation.messages.find(
    (message) => message.id === options.assistantMessageId
  )
  if (!assistantMessage || assistantMessage.role !== "assistant") {
    throw new Error(
      `Assistant message ${options.assistantMessageId} was not found`
    )
  }
  if (assistantMessage.status !== "streaming") {
    throw new Error(
      `Assistant message ${options.assistantMessageId} is already terminal`
    )
  }

  return {
    ...conversation,
    messages: conversation.messages.map((message) =>
      message.id === options.assistantMessageId
        ? {
            ...assistantMessage,
            status: options.status,
            finishReason: options.finishReason,
            updatedAt: options.timestamp
          }
        : message
    )
  }
}
