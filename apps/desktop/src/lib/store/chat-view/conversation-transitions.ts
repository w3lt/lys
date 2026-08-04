import type { ChatApiStreamEvent } from "@lys/protocol"
import type {
  Conversation,
  ConversationAssistantMessage,
  ConversationAssistantMessageFinishReason,
  ConversationMetadata,
  ConversationUserMessage
} from "@lys/share"

/** Immutable user message published by the chat-view store. */
export type ReadonlyConversationUserMessage = Readonly<ConversationUserMessage>

/** Immutable shared assistant fields independent of lifecycle state. */
type ReadonlyConversationAssistantMessageBase = Readonly<
  Omit<ConversationAssistantMessage, "status" | "finishReason">
>

/** Immutable assistant message that can accept stream deltas. */
export type StreamingConversationAssistantMessage =
  ReadonlyConversationAssistantMessageBase & {
    /** Active lifecycle state accepting content deltas. */
    readonly status: "streaming"
    /** Streaming replies do not yet have a completion reason. */
    readonly finishReason: null
  }

/** Immutable assistant message whose reply lifecycle is terminal. */
export type TerminalConversationAssistantMessage =
  | (ReadonlyConversationAssistantMessageBase & {
      /** Successful terminal lifecycle state. */
      readonly status: "completed"
      /** Model reason that ended successful generation. */
      readonly finishReason: ConversationAssistantMessageFinishReason
    })
  | (ReadonlyConversationAssistantMessageBase & {
      /** Terminal lifecycle state without model completion. */
      readonly status: "interrupted" | "failed"
      /** Interrupted and failed replies have no model completion reason. */
      readonly finishReason: null
    })

/** Immutable message valid in the completed transcript prefix. */
export type CompletedConversationMessage =
  ReadonlyConversationUserMessage | TerminalConversationAssistantMessage

/** Immutable lifecycle-refined message published to the chat view. */
export type ReadonlyConversationMessage =
  CompletedConversationMessage | StreamingConversationAssistantMessage

/** Transitively immutable conversation published by the chat-view store. */
export type ChatViewConversation = Readonly<
  Omit<Conversation, "messages"> & {
    /** Immutable ordered transcript owned by this conversation. */
    readonly messages: readonly ReadonlyConversationMessage[]
  }
>

/** Inputs required to append one backend-owned turn to a conversation. */
export type StartConversationTurnOptions = {
  /** Latest metadata returned by the backend for the active conversation. */
  readonly conversationMetadata: ConversationMetadata
  /** Existing local conversation whose transcript may be preserved. */
  readonly previousConversation?: ChatViewConversation
  /** Persisted user message acknowledged by the backend. */
  readonly userMessage: ConversationUserMessage
  /** Persisted assistant message that will receive streamed content. */
  readonly assistantMessage: StreamingConversationAssistantMessage
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
 * Determines whether a package-valid assistant can begin reply streaming.
 *
 * @param message - Protocol-validated assistant received at turn start.
 * @returns Whether the assistant is streaming without a completion reason.
 */
export function isStreamingConversationAssistantMessage(
  message: Readonly<ConversationAssistantMessage>
): message is StreamingConversationAssistantMessage {
  return message.status === "streaming" && message.finishReason === null
}

/**
 * Determines whether an immutable message belongs in the completed prefix.
 *
 * @param message - Lifecycle-refined message published by the chat-view store.
 * @returns Whether the message is a user message or terminal assistant.
 */
export function isCompletedConversationMessage(
  message: ReadonlyConversationMessage
): message is CompletedConversationMessage {
  return message.role === "user" || message.status !== "streaming"
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
): ChatViewConversation {
  const previousMessages =
    options.previousConversation?.id === options.conversationMetadata.id
      ? options.previousConversation.messages
      : []
  const userMessage = Object.freeze({ ...options.userMessage })
  const assistantMessage = Object.freeze({ ...options.assistantMessage })
  const messages = Object.freeze([
    ...previousMessages,
    userMessage,
    assistantMessage
  ] satisfies readonly ReadonlyConversationMessage[])

  return Object.freeze({
    ...options.conversationMetadata,
    messages
  })
}

/**
 * Replaces conversation metadata title without changing transcript messages.
 *
 * @param conversation - Conversation whose title is being updated.
 * @param title - Non-empty title emitted by the chat stream.
 * @returns A new conversation with the supplied title.
 */
export function updateConversationTitle(
  conversation: ChatViewConversation,
  title: string
): ChatViewConversation {
  return Object.freeze({ ...conversation, title })
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
  conversation: ChatViewConversation,
  options: UpdateAssistantReplyContentOptions
): ChatViewConversation {
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

  const updatedAssistantMessage = Object.freeze({
    ...assistantMessage,
    content: assistantMessage.content + options.content,
    updatedAt: options.timestamp
  } satisfies StreamingConversationAssistantMessage)
  const messages = Object.freeze(
    conversation.messages.map((message) =>
      message.id === options.assistantMessageId
        ? updatedAssistantMessage
        : message
    )
  )

  return Object.freeze({
    ...conversation,
    messages
  })
}

/**
 * Creates one immutable terminal assistant from its streaming predecessor.
 *
 * @param assistantMessage - Active assistant accepting reply deltas.
 * @param options - Exact terminal lifecycle transition to publish.
 * @returns A frozen assistant in the requested valid terminal state.
 */
function createTerminalConversationAssistantMessage(
  assistantMessage: StreamingConversationAssistantMessage,
  options: UpdateAssistantReplyStatusOptions
): TerminalConversationAssistantMessage {
  if (options.status === "completed") {
    return Object.freeze({
      ...assistantMessage,
      status: options.status,
      finishReason: options.finishReason,
      updatedAt: options.timestamp
    })
  }

  return Object.freeze({
    ...assistantMessage,
    status: options.status,
    finishReason: options.finishReason,
    updatedAt: options.timestamp
  })
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
  conversation: ChatViewConversation,
  options: UpdateAssistantReplyStatusOptions
): ChatViewConversation {
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

  const terminalAssistantMessage = createTerminalConversationAssistantMessage(
    assistantMessage,
    options
  )
  const messages = Object.freeze(
    conversation.messages.map((message) =>
      message.id === options.assistantMessageId
        ? terminalAssistantMessage
        : message
    )
  )

  return Object.freeze({
    ...conversation,
    messages
  })
}
