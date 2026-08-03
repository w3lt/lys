import type { ChatApiStreamEvent } from "@lys/protocol"
import type { Conversation, ConversationMetadata } from "@lys/share"

/** Inputs required to start one assistant reply in a conversation. */
export type StartAssistantReplyOptions = {
  /** Latest metadata returned by the backend for the active conversation. */
  readonly conversationMetadata: ConversationMetadata
  /** Existing local conversation whose transcript may be preserved. */
  readonly previousConversation?: Conversation
  /** Backend-owned identifier of the new assistant message. */
  readonly assistantMessageId: string
  /** Model identifier used for the submitted turn. */
  readonly model: string
  /** ISO timestamp applied to the new assistant message. */
  readonly timestamp: string
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
 * Combines backend metadata with the local transcript and starts one reply.
 *
 * @param options - Metadata, prior state, and new turn identifiers.
 * @returns A new conversation containing the backend-identified assistant
 * message after any history belonging to the same conversation.
 */
export function startAssistantReply(
  options: StartAssistantReplyOptions
): Conversation {
  const previousMessages =
    options.previousConversation?.id === options.conversationMetadata.id
      ? options.previousConversation.messages
      : []

  return {
    ...options.conversationMetadata,
    messages: [
      ...previousMessages,
      {
        id: options.assistantMessageId,
        model: options.model,
        role: "assistant",
        content: "",
        status: "streaming",
        finishReason: null,
        createdAt: options.timestamp,
        updatedAt: options.timestamp
      }
    ]
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
