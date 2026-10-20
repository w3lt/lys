import type { ChatApiStreamEvent } from "@lys/protocol"
import type {
  Conversation,
  ConversationAssistantMessage,
  ConversationAssistantMessageFinishReason,
  ConversationMessage,
  ConversationMetadata,
  ConversationSource,
  ConversationUserMessage,
  ReplyPart,
  ToolCallReplyPartStatus
} from "@lys/share"

import {
  buildChatViewReplyPart,
  listAnswerCitationNumbers,
  type ChatViewReplyPart,
  type ChatViewToolCallReplyPart
} from "./reply-parts"

/** Immutable user message published by the chat-view store. */
export type ReadonlyConversationUserMessage = Readonly<ConversationUserMessage>

/** Immutable shared assistant fields independent of lifecycle state. */
type ReadonlyConversationAssistantMessageBase = Readonly<
  Omit<ConversationAssistantMessage, "status" | "finishReason" | "parts">
> & {
  /** The reply's parts in stored order, as the chat view holds them. */
  readonly parts: readonly ChatViewReplyPart[]
  /**
   * Numbers the reply's answer cites in its prose, once each, in first-cited
   * order, as {@link listAnswerCitationNumbers} lists them when the parts
   * change, so rendering never parses the answer to count them.
   */
  readonly answerCitationNumbers: readonly number[]
}

/** Validated assistant record, as the backend sent it, that is streaming. */
export type StreamingAssistantMessageRecord =
  Readonly<ConversationAssistantMessage> & {
    /** Active lifecycle state accepting parts and fragments. */
    readonly status: "streaming"
    /** Streaming replies do not yet have a completion reason. */
    readonly finishReason: null
  }

/** A tool call that is still open: waiting for the person or running. */
type OpenToolCallReplyPart = ChatViewToolCallReplyPart & {
  /** State of a call that has not ended. */
  readonly status: "awaiting-approval" | "running"
}

/** Immutable assistant message that can accept new parts and fragments. */
export type StreamingConversationAssistantMessage =
  ReadonlyConversationAssistantMessageBase & {
    /** Active lifecycle state accepting parts and fragments. */
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
 * metadata-only transition may reuse the existing immutable message and
 * source collections by identity; part or lifecycle transitions create a new
 * frozen message collection and replace only the affected message, and a
 * source transition creates a new frozen source collection. Consumers may
 * retain snapshots safely; no transition mutates a previous conversation,
 * message, part, or source object.
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
  /** Persisted assistant message that will receive streamed parts. */
  readonly assistantMessage: StreamingAssistantMessageRecord
}

/** Inputs required to add or replace one part of a streaming reply. */
export type UpdateAssistantReplyPartOptions = {
  /** Identifier of the streaming assistant message the part belongs to. */
  readonly assistantMessageId: string
  /** Protocol-validated part, complete as the backend stored it. */
  readonly part: ReplyPart
}

/** Inputs required to append one stored fragment to a reply part. */
export type UpdateAssistantReplyPartContentOptions = {
  /** Identifier of the streaming assistant message the part belongs to. */
  readonly assistantMessageId: string
  /** Identifier of the reasoning or text part the fragment extends. */
  readonly partId: string
  /** Non-empty fragment emitted by the chat stream. */
  readonly content: string
  /** Time the backend stored the fragment, the part's new update time. */
  readonly updatedAt: string
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
 * @param message - Protocol-validated assistant received at turn start, or a
 * stored or snapshot reply.
 * @returns Whether the assistant is streaming without a completion reason.
 */
export function isStreamingConversationAssistantMessage(
  message: Readonly<ConversationAssistantMessage>
): message is StreamingAssistantMessageRecord {
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

/** Sources of a conversation that has none. */
const NO_SOURCES: readonly ConversationSource[] = Object.freeze([])

/**
 * Combines backend metadata and messages with matching local history.
 *
 * @param options - Metadata, prior state, and the new backend-owned turn.
 * @returns A frozen conversation containing matching history followed by the
 * user and assistant messages received from the backend, and the matching
 * history's sources.
 * @remarks History and sources are preserved only when the metadata
 * identifier matches the prior conversation. A new identifier intentionally
 * starts a fresh transcript without sources.
 */
export function startConversationTurn(
  options: StartConversationTurnOptions
): ChatViewConversation {
  const previousConversation =
    options.previousConversation?.id === options.conversationMetadata.id
      ? options.previousConversation
      : undefined
  const userMessage = Object.freeze({ ...options.userMessage })
  const assistantMessage = createStreamingAssistantMessage(
    options.assistantMessage
  )
  const messages = Object.freeze([
    ...(previousConversation?.messages ?? []),
    userMessage,
    assistantMessage
  ] satisfies readonly ReadonlyConversationMessage[])

  return Object.freeze({
    ...options.conversationMetadata,
    messages,
    sources: previousConversation?.sources ?? NO_SOURCES
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
 * Finds the streaming assistant message a stream event addresses.
 *
 * @param conversation - Conversation containing the active assistant message.
 * @param assistantMessageId - Identifier of the addressed message.
 * @returns The streaming assistant message.
 * @throws If the message is absent or already terminal.
 */
function getStreamingAssistantMessage(
  conversation: ChatViewConversation,
  assistantMessageId: string
): StreamingConversationAssistantMessage {
  const assistantMessage = conversation.messages.find(
    (message) => message.id === assistantMessageId
  )
  if (assistantMessage?.role !== "assistant") {
    throw new Error(`Assistant message ${assistantMessageId} was not found`)
  }
  if (assistantMessage.status !== "streaming") {
    throw new Error(
      `Assistant message ${assistantMessageId} is already terminal`
    )
  }
  return assistantMessage
}

/**
 * Builds a conversation whose streaming reply has new parts.
 *
 * @param conversation - Conversation containing the streaming reply.
 * @param assistantMessage - The streaming reply before the change.
 * @param parts - The reply's parts after the change.
 * @returns A new frozen conversation with only that reply replaced, its
 * answer's citations listed again; the reply's own update time is kept, as
 * the backend keeps it.
 */
function buildConversationWithReplyParts(
  conversation: ChatViewConversation,
  assistantMessage: StreamingConversationAssistantMessage,
  parts: readonly ChatViewReplyPart[]
): ChatViewConversation {
  const updatedAssistantMessage = Object.freeze({
    ...assistantMessage,
    parts: Object.freeze(parts),
    answerCitationNumbers: listAnswerCitationNumbers(parts)
  } satisfies StreamingConversationAssistantMessage)
  const messages = Object.freeze(
    conversation.messages.map((message) =>
      message.id === assistantMessage.id ? updatedAssistantMessage : message
    )
  )
  return Object.freeze({ ...conversation, messages })
}

/**
 * Adds a new part to the streaming reply, or replaces the part stored under
 * the same identifier, such as a tool call that changed state.
 *
 * @param conversation - Conversation containing the active assistant message.
 * @param options - Assistant identifier and the part as stored.
 * @returns A new conversation whose reply holds the part: in place of the
 * earlier one with its identifier, else after every earlier part.
 * @throws If the owned assistant message is absent or already terminal.
 */
export function updateAssistantReplyPart(
  conversation: ChatViewConversation,
  options: UpdateAssistantReplyPartOptions
): ChatViewConversation {
  const assistantMessage = getStreamingAssistantMessage(
    conversation,
    options.assistantMessageId
  )
  const part = buildChatViewReplyPart(options.part)
  const isKnownPart = assistantMessage.parts.some(({ id }) => id === part.id)
  const parts = isKnownPart
    ? assistantMessage.parts.map((storedPart) =>
        storedPart.id === part.id ? part : storedPart
      )
    : [...assistantMessage.parts, part]
  return buildConversationWithReplyParts(conversation, assistantMessage, parts)
}

/**
 * Appends one stored fragment to a reasoning or text part of the streaming
 * reply.
 *
 * @param conversation - Conversation containing the active assistant message.
 * @param options - Assistant and part identifiers, the fragment, and the time
 * it was stored.
 * @returns A new conversation whose part ends with the fragment and carries
 * its update time.
 * @throws If the owned assistant message is absent or already terminal, or
 * the part is absent or a tool call.
 */
export function updateAssistantReplyPartContent(
  conversation: ChatViewConversation,
  options: UpdateAssistantReplyPartContentOptions
): ChatViewConversation {
  const assistantMessage = getStreamingAssistantMessage(
    conversation,
    options.assistantMessageId
  )
  const storedPart = assistantMessage.parts.find(
    ({ id }) => id === options.partId
  )
  if (storedPart === undefined || storedPart.kind === "tool-call") {
    throw new Error(
      `Reply part ${options.partId} is not a reasoning or text part of the reply`
    )
  }
  const part = Object.freeze({
    ...storedPart,
    content: storedPart.content + options.content,
    updatedAt: options.updatedAt
  })
  const parts = assistantMessage.parts.map((candidate) =>
    candidate.id === part.id ? part : candidate
  )
  return buildConversationWithReplyParts(conversation, assistantMessage, parts)
}

/**
 * Merges numbered sources into the conversation's sources.
 *
 * @param conversation - Conversation the sources belong to.
 * @param sources - Protocol-validated sources the backend stored.
 * @returns A new conversation holding every source once per number, in
 * number order. A source under a number already held is not taken, because
 * a number never changes its source: the held object is kept, so a reply
 * whose sources did not change gets the same objects.
 */
export function updateConversationSources(
  conversation: ChatViewConversation,
  sources: readonly ConversationSource[]
): ChatViewConversation {
  const sourcesByNumber = new Map(
    conversation.sources.map((source) => [source.number, source])
  )
  for (const source of sources) {
    if (!sourcesByNumber.has(source.number))
      sourcesByNumber.set(source.number, Object.freeze({ ...source }))
  }
  const mergedSources = Object.freeze(
    [...sourcesByNumber.values()].sort(
      (first, second) => first.number - second.number
    )
  )
  return Object.freeze({ ...conversation, sources: mergedSources })
}

/**
 * Answers whether a tool call in this state is still open.
 *
 * @param status - State of a tool call.
 * @returns True for `awaiting-approval` and `running`; false for every state
 * that ends a call.
 */
function isOpenToolCallStatus(status: ToolCallReplyPartStatus): boolean {
  switch (status) {
    case "awaiting-approval":
    case "running":
      return true
    case "interrupted":
    case "succeeded":
    case "failed":
    case "rejected":
      return false
  }
}

/**
 * Answers whether a part is a tool call that is still open.
 *
 * @param part - Part of a reply.
 * @returns True for a tool call {@link isOpenToolCallStatus} calls open.
 */
function isOpenToolCall(
  part: ChatViewReplyPart
): part is OpenToolCallReplyPart {
  return part.kind === "tool-call" && isOpenToolCallStatus(part.status)
}

/**
 * Builds the parts of a reply that ended: a waiting or running tool call
 * becomes interrupted at the time the reply ended, as the backend stores it
 * when the reply ends.
 *
 * @param parts - The reply's parts when it ended.
 * @param updatedAt - Time the reply ended, each interrupted call's update
 * time.
 * @returns Frozen parts; every other part is kept by identity.
 */
function buildEndedReplyParts(
  parts: readonly ChatViewReplyPart[],
  updatedAt: string
): readonly ChatViewReplyPart[] {
  return Object.freeze(
    parts.map((part): ChatViewReplyPart =>
      isOpenToolCall(part)
        ? Object.freeze({ ...part, status: "interrupted", updatedAt })
        : part
    )
  )
}

/**
 * Builds the parts of a stored reply that is streaming but can no longer
 * be written: a waiting or running tool call becomes interrupted and keeps
 * its own update time, as startup recovery stores it, since nothing records
 * when its generation stopped.
 *
 * @param parts - Schema-validated parts in stored order.
 * @returns Frozen copies of the parts.
 */
function buildAbandonedReplyParts(
  parts: readonly ReplyPart[]
): readonly ChatViewReplyPart[] {
  return Object.freeze(
    buildStoredReplyParts(parts).map((part): ChatViewReplyPart =>
      isOpenToolCall(part)
        ? Object.freeze({ ...part, status: "interrupted" })
        : part
    )
  )
}

/**
 * Creates one immutable terminal assistant from its streaming predecessor.
 *
 * @param assistantMessage - Active assistant accepting parts and fragments.
 * @param options - Exact terminal lifecycle transition to publish.
 * @returns A frozen assistant in the requested valid terminal state.
 * @remarks The transition preserves the streaming message identity and
 * parts while replacing status, finish reason, and update timestamp; a
 * waiting or running tool call becomes interrupted at that timestamp. No
 * text changes, so the answer's citations are kept.
 */
function createTerminalConversationAssistantMessage(
  assistantMessage: StreamingConversationAssistantMessage,
  options: UpdateAssistantReplyStatusOptions
): TerminalConversationAssistantMessage {
  const parts = buildEndedReplyParts(assistantMessage.parts, options.timestamp)
  if (options.status === "completed") {
    return Object.freeze({
      ...assistantMessage,
      parts,
      status: options.status,
      finishReason: options.finishReason,
      updatedAt: options.timestamp
    })
  }

  return Object.freeze({
    ...assistantMessage,
    parts,
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
 * assistants cannot receive later parts, fragments, or another terminal
 * transition.
 */
export function updateAssistantReplyStatus(
  conversation: ChatViewConversation,
  options: UpdateAssistantReplyStatusOptions
): ChatViewConversation {
  const assistantMessage = conversation.messages.find(
    (message) => message.id === options.assistantMessageId
  )
  if (assistantMessage?.role !== "assistant") {
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
 * it is presented as interrupted with the parts stored so far, its waiting
 * and running tool calls presented as interrupted too, each at its own
 * update time. The stored record itself is not changed.
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
        ...buildStoredReplyContent(buildAbandonedReplyParts(message.parts)),
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
        ...buildStoredReplyContent(buildStoredReplyParts(message.parts)),
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
        ...buildStoredReplyContent(buildStoredReplyParts(message.parts)),
        status: message.status,
        finishReason: message.finishReason,
        updatedAt: message.updatedAt
      })
  }
}

/**
 * Builds the immutable parts of a stored or snapshot reply.
 *
 * @param parts - Schema-validated parts in stored order.
 * @returns A frozen copy holding the chat view's frozen copies of the parts,
 * as {@link buildChatViewReplyPart} builds them.
 */
function buildStoredReplyParts(
  parts: readonly ReplyPart[]
): readonly ChatViewReplyPart[] {
  return Object.freeze(parts.map(buildChatViewReplyPart))
}

/**
 * Builds a stored reply's parts with its answer's citations.
 *
 * @param parts - The chat view's frozen parts of the reply.
 * @returns The parts and the numbers their answer cites, as
 * {@link listAnswerCitationNumbers} lists them.
 */
function buildStoredReplyContent(
  parts: readonly ChatViewReplyPart[]
): Pick<
  StreamingConversationAssistantMessage,
  "parts" | "answerCitationNumbers"
> {
  return { parts, answerCitationNumbers: listAnswerCitationNumbers(parts) }
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
 * @param message - Stored, snapshot, or turn-start reply that is streaming
 * without a finish reason.
 * @returns A frozen streaming assistant carrying the record's parts and
 * update time.
 */
function createStreamingAssistantMessage(
  message: StreamingAssistantMessageRecord
): StreamingConversationAssistantMessage {
  return Object.freeze({
    id: message.id,
    createdAt: message.createdAt,
    model: message.model,
    role: message.role,
    ...buildStoredReplyContent(buildStoredReplyParts(message.parts)),
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
    agentCode: conversation.agentCode,
    messages,
    sources: Object.freeze(
      conversation.sources.map((source) => Object.freeze({ ...source }))
    ),
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
 * @returns A new conversation whose reply carries the snapshot's parts,
 * status, finish reason, and update time.
 * @throws If the reply is absent or already terminal locally, or a final
 * snapshot violates its status and finish-reason pairing.
 * @remarks The snapshot contains every part and fragment sent before it, so
 * it replaces the local parts instead of adding to them.
 */
export function updateAssistantReplyWithSnapshot(
  conversation: ChatViewConversation,
  snapshot: ConversationAssistantMessage
): ChatViewConversation {
  const assistantMessage = conversation.messages.find(
    (message) => message.id === snapshot.id
  )
  if (assistantMessage?.role !== "assistant") {
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
