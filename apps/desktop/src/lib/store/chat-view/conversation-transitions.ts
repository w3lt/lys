import type { ChatApiStreamEvent } from "@lys/protocol"
import type {
  Conversation,
  ConversationAssistantMessage,
  ConversationAssistantMessageFinishReason,
  ConversationMessage,
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

/**
 * Transitively immutable conversation published by the chat-view store.
 *
 * @remarks Every transition returns a new frozen outer conversation. A
 * metadata-only transition may reuse the existing immutable message collection
 * by identity; content or lifecycle transitions create a new frozen collection
 * and replace only the affected message. Consumers may retain snapshots
 * safely; no transition mutates a previous conversation or message object.
 */
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
 * @returns A frozen conversation containing matching history followed by the
 * user and assistant messages received from the backend.
 * @remarks History is preserved only when the metadata identifier matches the
 * prior conversation. A new identifier intentionally starts a fresh transcript.
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
 * @param title - Protocol-validated non-empty title emitted by the chat stream.
 * @returns A new conversation with the supplied title.
 * @remarks The helper trusts the validated stream contract and changes only
 * outer metadata; the ordered immutable message snapshot is reused by identity.
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
 * @param options - Assistant identifier, protocol-validated delta content, and
 * update timestamp.
 * @returns A new conversation containing the appended assistant content.
 * @throws If the owned assistant message is absent or already terminal.
 * @remarks Only a streaming assistant accepts deltas. The prior conversation
 * remains unchanged and the message's content is appended in event order.
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
 * @remarks The transition preserves the streaming message identity and
 * content while replacing status, finish reason, and update timestamp.
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
 * @remarks Terminal state is one-way: completed, interrupted, and failed
 * assistants cannot receive later deltas or another terminal transition.
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

/**
 * Creates one immutable terminal assistant from a stored assistant record.
 *
 * @param message - Schema-validated assistant read from conversation storage.
 * @returns A frozen terminal assistant valid in the completed prefix.
 * @throws If a completed message lacks a finish reason, or an interrupted or
 * failed message carries one; storage constraints forbid both.
 * @remarks A stored `streaming` status here belongs to a reply that does not
 * end the transcript, so no generation can still be writing it for this view;
 * it is presented as interrupted with the content stored so far. The stored
 * record itself is not changed.
 */
function createStoredAssistantMessage(
  message: ConversationAssistantMessage
): TerminalConversationAssistantMessage {
  switch (message.status) {
    case "streaming":
      return Object.freeze({
        id: message.id,
        createdAt: message.createdAt,
        model: message.model,
        role: message.role,
        content: message.content,
        status: "interrupted",
        finishReason: null,
        updatedAt: message.updatedAt
      })
    case "completed":
      if (message.finishReason === null) {
        throw new Error(`Stored reply ${message.id} has no finish reason`)
      }
      return Object.freeze({
        id: message.id,
        createdAt: message.createdAt,
        model: message.model,
        role: message.role,
        content: message.content,
        status: message.status,
        finishReason: message.finishReason,
        updatedAt: message.updatedAt
      })
    case "interrupted":
    case "failed":
      if (message.finishReason !== null) {
        throw new Error(`Stored reply ${message.id} has a finish reason`)
      }
      return Object.freeze({
        id: message.id,
        createdAt: message.createdAt,
        model: message.model,
        role: message.role,
        content: message.content,
        status: message.status,
        finishReason: message.finishReason,
        updatedAt: message.updatedAt
      })
  }
}

/**
 * Creates one immutable completed-prefix message from a stored record.
 *
 * @param message - Schema-validated message read from conversation storage.
 * @returns A frozen user message or terminal assistant.
 * @throws If a stored assistant violates its status and finish-reason pairing.
 */
function createStoredConversationMessage(
  message: ConversationMessage
): CompletedConversationMessage {
  if (message.role === "assistant") {
    return createStoredAssistantMessage(message)
  }

  return Object.freeze({
    id: message.id,
    createdAt: message.createdAt,
    role: message.role,
    content: message.content
  })
}

/**
 * Creates one immutable streaming assistant from a validated record.
 *
 * @param message - Stored or snapshot reply that is streaming without a
 * finish reason.
 * @returns A frozen streaming assistant carrying the record's content and
 * update time.
 */
function createStreamingAssistantMessage(
  message: StreamingConversationAssistantMessage
): StreamingConversationAssistantMessage {
  return Object.freeze({
    id: message.id,
    createdAt: message.createdAt,
    model: message.model,
    role: message.role,
    content: message.content,
    status: message.status,
    finishReason: message.finishReason,
    updatedAt: message.updatedAt
  })
}

/**
 * Creates the immutable last message of a stored transcript.
 *
 * @param message - Schema-validated message that ends the transcript.
 * @returns A streaming assistant when the stored reply is still streaming,
 * because its generation may still be running and the chat view follows it;
 * otherwise the same message as {@link createStoredConversationMessage}.
 * @throws If a stored assistant violates its status and finish-reason pairing.
 */
function createStoredLastMessage(
  message: ConversationMessage
): ReadonlyConversationMessage {
  if (
    message.role === "assistant" &&
    isStreamingConversationAssistantMessage(message)
  ) {
    return createStreamingAssistantMessage(message)
  }

  return createStoredConversationMessage(message)
}

/**
 * Creates the chat-view conversation for a stored conversation being opened.
 *
 * @param conversation - Schema-validated conversation read from storage.
 * @returns A transitively frozen conversation in stored order.
 * @throws If a stored assistant violates its status and finish-reason pairing.
 * @remarks A `streaming` reply that ends the transcript stays streaming so the
 * chat view can follow its generation; {@link findStreamingReply} finds it.
 * Any earlier `streaming` reply is presented as interrupted.
 */
export function createStoredChatViewConversation(
  conversation: Conversation
): ChatViewConversation {
  const lastIndex = conversation.messages.length - 1
  const messages = Object.freeze(
    conversation.messages.map((message, index): ReadonlyConversationMessage =>
      index === lastIndex
        ? createStoredLastMessage(message)
        : createStoredConversationMessage(message)
    )
  )

  return Object.freeze({
    id: conversation.id,
    title: conversation.title,
    systemPrompt: conversation.systemPrompt,
    messages,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt
  } satisfies ChatViewConversation)
}

/**
 * Finds the streaming reply that ends a conversation.
 *
 * @param conversation - Conversation published by the chat-view store.
 * @returns The last message when it is a streaming assistant, otherwise
 * undefined.
 */
export function findStreamingReply(
  conversation: ChatViewConversation
): StreamingConversationAssistantMessage | undefined {
  const lastMessage = conversation.messages.at(-1)
  return lastMessage?.role === "assistant" && lastMessage.status === "streaming"
    ? lastMessage
    : undefined
}

/**
 * Replaces a followed streaming reply with the backend's stored snapshot.
 *
 * @param conversation - Conversation whose streaming reply is followed.
 * @param snapshot - Schema-validated stored reply sent when following began.
 * @returns A new conversation whose reply carries the snapshot's content,
 * status, finish reason, and update time.
 * @throws If the reply is absent or already terminal locally, or a final
 * snapshot violates its status and finish-reason pairing.
 * @remarks The snapshot contains every delta sent before it, so it replaces
 * the local content instead of appending to it.
 */
export function updateAssistantReplyWithSnapshot(
  conversation: ChatViewConversation,
  snapshot: ConversationAssistantMessage
): ChatViewConversation {
  const assistantMessage = conversation.messages.find(
    (message) => message.id === snapshot.id
  )
  if (!assistantMessage || assistantMessage.role !== "assistant") {
    throw new Error(`Assistant message ${snapshot.id} was not found`)
  }
  if (assistantMessage.status !== "streaming") {
    throw new Error(`Assistant message ${snapshot.id} is already terminal`)
  }

  const updatedAssistantMessage = isStreamingConversationAssistantMessage(
    snapshot
  )
    ? createStreamingAssistantMessage(snapshot)
    : createStoredAssistantMessage(snapshot)
  const messages = Object.freeze(
    conversation.messages.map((message) =>
      message.id === snapshot.id ? updatedAssistantMessage : message
    )
  )

  return Object.freeze({
    ...conversation,
    messages
  })
}
