import {
  chatReplyNotFoundProblemSchema,
  chatReplyNotGeneratingProblemSchema,
  conversationNotFoundProblemSchema,
  listConversationsApi,
  type ChatReplyNotFoundProblem,
  type ChatReplyNotGeneratingProblem,
  type ConversationNotFoundProblem,
  type ConversationPreview,
  type ConversationSummary,
  type ListConversationsApiResponse
} from "@lys/protocol"
import {
  CALIGINIA_AGENT_CODE,
  conversationAssistantMessageSchema,
  conversationMetadataSchema,
  conversationSchema,
  conversationUserMessageSchema,
  replyPartSchema,
  type Conversation,
  type ConversationAssistantMessage,
  type ConversationMessage,
  type ConversationMetadata,
  type ConversationSource,
  type ConversationUserMessage,
  type ReplyPart,
  type ToolCallReplyPart
} from "@lys/share"
import {
  buildChatViewReplyPart,
  listAnswerCitationNumbers,
  type ChatViewReplyPart,
  type ChatViewToolCallReplyPart
} from "@/lib/store/chat-view/reply-parts"

/**
 * Creates a syntactically valid UUIDv7 whose last group encodes `sequence`.
 *
 * @param sequence - Non-negative integer below 2^48; larger values sort later
 * when the timestamp groups are equal.
 * @returns A lowercase UUIDv7 string.
 */
export function createFixtureUuidV7(sequence: number): string {
  return `01900000-0000-7000-8000-${sequence.toString(16).padStart(12, "0")}`
}

/** Conversation identity used by single-conversation fixtures. */
export const FIXTURE_CONVERSATION_ID = createFixtureUuidV7(1)

/** Timestamp shared by fixtures whose time is not under test. */
export const FIXTURE_TIMESTAMP = "2026-01-02T03:04:05.678Z"

/** Model that owns assistant-message fixtures. */
export const FIXTURE_MODEL = "fixture-model"

/**
 * Builds a stored user message.
 *
 * @param sequence - Identity sequence of the message.
 * @param content - Non-empty authored text.
 * @returns A frozen user message validated by the shared schema.
 */
export function buildUserMessage(
  sequence: number,
  content: string
): ConversationUserMessage {
  return Object.freeze(
    conversationUserMessageSchema.parse({
      id: createFixtureUuidV7(sequence),
      role: "user",
      content,
      createdAt: FIXTURE_TIMESTAMP
    })
  )
}

/** Fields every assistant-message fixture shares, by lifecycle. */
type AssistantMessageFixture<
  Status extends ConversationAssistantMessage["status"],
  FinishReason extends ConversationAssistantMessage["finishReason"]
> = Readonly<
  Omit<ConversationAssistantMessage, "status" | "finishReason"> & {
    /** Lifecycle state of the reply. */
    status: Status
    /** Model completion reason; set only for a completed reply. */
    finishReason: FinishReason
  }
>

/**
 * Freezes an assistant-message fixture after the shared schema accepts it.
 *
 * @param message - Fixture whose literal type records its lifecycle.
 * @returns The same fixture, frozen, keeping its precise type.
 */
function buildValidatedAssistantMessage<T extends ConversationAssistantMessage>(
  message: T
): Readonly<T> {
  conversationAssistantMessageSchema.parse(message)
  return Object.freeze(message)
}

/** Sequence offset of the text part a reply built from text holds. */
const TEXT_PART_SEQUENCE_OFFSET = 0x10000

/** Kind, identity, round, and text of a reasoning or text part fixture. */
type FragmentPartFixture = Readonly<{
  /** Kind of the part. */
  kind: "reasoning" | "text"
  /** Identity sequence of the part. */
  sequence: number
  /** Zero-based round of the part. */
  round: number
  /** Non-empty text of the part. */
  content: string
}>

/** A stored reasoning or text part, which the chat view holds as it is. */
export type FragmentReplyPart = Exclude<ReplyPart, { kind: "tool-call" }>

/**
 * Builds a stored reasoning or text part.
 *
 * @param fixture - Kind, identity sequence, round, and text of the part.
 * @returns A frozen part stored at {@link FIXTURE_TIMESTAMP}, validated by the
 * shared schema.
 * @throws If the shared schema reads the fixture as a tool call.
 */
function buildFragmentPart(fixture: FragmentPartFixture): FragmentReplyPart {
  const part = replyPartSchema.parse({
    kind: fixture.kind,
    id: createFixtureUuidV7(fixture.sequence),
    round: fixture.round,
    createdAt: FIXTURE_TIMESTAMP,
    updatedAt: FIXTURE_TIMESTAMP,
    content: fixture.content
  })
  if (part.kind === "tool-call")
    throw new Error("A reasoning or text fixture was read as a tool call")
  return Object.freeze(part)
}

/**
 * Builds a stored text part.
 *
 * @param sequence - Identity sequence of the part.
 * @param round - Zero-based round of the part.
 * @param content - Non-empty text the model wrote.
 * @returns A frozen part stored at {@link FIXTURE_TIMESTAMP}, validated by the
 * shared schema.
 */
export function buildTextPart(
  sequence: number,
  round: number,
  content: string
): FragmentReplyPart {
  return buildFragmentPart({ kind: "text", sequence, round, content })
}

/**
 * Builds a stored reasoning part.
 *
 * @param sequence - Identity sequence of the part.
 * @param round - Zero-based round of the part.
 * @param content - Non-empty reasoning the model sent.
 * @returns A frozen part stored at {@link FIXTURE_TIMESTAMP}, validated by the
 * shared schema.
 */
export function buildReasoningPart(
  sequence: number,
  round: number,
  content: string
): FragmentReplyPart {
  return buildFragmentPart({ kind: "reasoning", sequence, round, content })
}

/** State-dependent fields of a tool-call fixture. */
export type ToolCallPartFixtureState =
  | Readonly<{ status: "awaiting-approval" | "running" | "interrupted" }>
  | Readonly<{
      status: "succeeded"
      result: string
      sourceNumbers: readonly number[]
    }>
  | Readonly<{ status: "failed" | "rejected"; result: string }>

/** The call a tool-call fixture holds, in the state it is in. */
export type ToolCallPartFixture = Readonly<{
  /** Name the model called. */
  toolName: string
  /** Argument text as the model wrote it. */
  argumentText: string
}> &
  ToolCallPartFixtureState

/**
 * Builds a stored tool call.
 *
 * @param sequence - Identity sequence of the call.
 * @param round - Zero-based round of the call.
 * @param call - Tool name, the model's argument text, and the call's state,
 * with its result and source numbers when the state has them.
 * @returns A frozen call stored at {@link FIXTURE_TIMESTAMP}, validated by the
 * shared schema.
 */
export function buildToolCallPart(
  sequence: number,
  round: number,
  call: ToolCallPartFixture
): ToolCallReplyPart {
  const part = replyPartSchema.parse({
    kind: "tool-call",
    id: createFixtureUuidV7(sequence),
    round,
    createdAt: FIXTURE_TIMESTAMP,
    updatedAt: FIXTURE_TIMESTAMP,
    ...call
  })
  if (part.kind !== "tool-call") throw new Error("Expected a tool-call part")
  return Object.freeze(part)
}

/**
 * Builds a tool call as the chat view holds it.
 *
 * @param call - Stored call, as {@link buildToolCallPart} builds it.
 * @returns The copy {@link buildChatViewReplyPart} builds, which carries the
 * call's parsed arguments.
 * @throws If the copy is not a tool call.
 */
export function buildChatViewToolCallPart(
  call: ToolCallReplyPart
): ChatViewToolCallReplyPart {
  const part = buildChatViewReplyPart(call)
  if (part.kind !== "tool-call") throw new Error("Expected a tool-call part")
  return part
}

/**
 * Builds the parts of a reply fixture.
 *
 * @param sequence - Identity sequence of the reply.
 * @param body - The reply's parts, or its text, which becomes one text part
 * of round 0 as a reply stored before parts existed; empty text means no
 * parts.
 * @returns The parts in stored order.
 */
function buildReplyParts(
  sequence: number,
  body: string | readonly ReplyPart[]
): readonly ReplyPart[] {
  if (typeof body !== "string") return Object.freeze([...body])
  if (body === "") return Object.freeze([])
  return Object.freeze([
    buildTextPart(TEXT_PART_SEQUENCE_OFFSET + sequence, 0, body)
  ])
}

/**
 * Builds the shared fields of an assistant message from {@link FIXTURE_MODEL}.
 *
 * @param sequence - Identity sequence of the message.
 * @param body - Stored parts, or stored reply text, possibly empty.
 * @returns The fields that do not depend on the lifecycle.
 */
function buildAssistantMessageBase(
  sequence: number,
  body: string | readonly ReplyPart[]
) {
  return {
    id: createFixtureUuidV7(sequence),
    role: "assistant" as const,
    model: FIXTURE_MODEL,
    parts: buildReplyParts(sequence, body),
    createdAt: FIXTURE_TIMESTAMP,
    updatedAt: FIXTURE_TIMESTAMP
  }
}

/**
 * Builds an assistant message whose generation is still running.
 *
 * @param sequence - Identity sequence of the message.
 * @param body - Parts received so far, or their text as one text part;
 * possibly empty.
 * @returns A frozen streaming reply validated by the shared schema.
 */
export function buildStreamingAssistantMessage(
  sequence: number,
  body: string | readonly ReplyPart[]
): AssistantMessageFixture<"streaming", null> {
  return buildValidatedAssistantMessage({
    ...buildAssistantMessageBase(sequence, body),
    status: "streaming" as const,
    finishReason: null
  })
}

/**
 * Builds an assistant message the model completed.
 *
 * @param sequence - Identity sequence of the message.
 * @param body - The reply's parts, or its text as one text part.
 * @param finishReason - Reason the model stopped; defaults to `stop`.
 * @returns A frozen completed reply validated by the shared schema.
 */
export function buildCompletedAssistantMessage(
  sequence: number,
  body: string | readonly ReplyPart[],
  finishReason: "stop" | "length" = "stop"
): AssistantMessageFixture<"completed", "stop" | "length"> {
  return buildValidatedAssistantMessage({
    ...buildAssistantMessageBase(sequence, body),
    status: "completed" as const,
    finishReason
  })
}

/**
 * Builds an assistant message whose generation ended without completing.
 *
 * @param sequence - Identity sequence of the message.
 * @param body - Parts stored before it ended, or their text as one text
 * part.
 * @param status - Whether the reply was interrupted or failed.
 * @returns A frozen ended reply validated by the shared schema.
 */
export function buildEndedAssistantMessage(
  sequence: number,
  body: string | readonly ReplyPart[],
  status: "interrupted" | "failed"
): AssistantMessageFixture<"interrupted" | "failed", null> {
  return buildValidatedAssistantMessage({
    ...buildAssistantMessageBase(sequence, body),
    status,
    finishReason: null
  })
}

/** An assistant message fixture as the chat view holds it. */
export type ChatViewAssistantMessageFixture<
  Message extends ConversationAssistantMessage
> = Readonly<
  Omit<Message, "parts"> & {
    /** The reply's parts as the chat view's store builds them. */
    parts: readonly ChatViewReplyPart[]
    /** Numbers the reply's answer cites, as the store lists them. */
    answerCitationNumbers: readonly number[]
  }
>

/**
 * Builds the chat view's copy of an assistant message fixture, as its store
 * builds one from a stored or streamed reply.
 *
 * @param message - Assistant message validated by the shared schema.
 * @returns A frozen copy whose parts {@link buildChatViewReplyPart} built,
 * so a tool call carries its parsed arguments, with the numbers its answer
 * cites as {@link listAnswerCitationNumbers} lists them.
 */
export function buildChatViewAssistantMessage<
  Message extends ConversationAssistantMessage
>(message: Readonly<Message>): ChatViewAssistantMessageFixture<Message> {
  const parts = Object.freeze(message.parts.map(buildChatViewReplyPart))
  return Object.freeze({
    ...message,
    parts,
    answerCitationNumbers: listAnswerCitationNumbers(parts)
  })
}

/**
 * Builds a streaming reply as the chat view holds it.
 *
 * @param sequence - Identity sequence of the message.
 * @param body - Parts received so far, or their text as one text part;
 * possibly empty.
 * @returns {@link buildStreamingAssistantMessage}'s reply, as
 * {@link buildChatViewAssistantMessage} copies it.
 */
export function buildStreamingChatViewReply(
  sequence: number,
  body: string | readonly ReplyPart[]
): ChatViewAssistantMessageFixture<AssistantMessageFixture<"streaming", null>> {
  return buildChatViewAssistantMessage(
    buildStreamingAssistantMessage(sequence, body)
  )
}

/**
 * Builds a completed reply as the chat view holds it.
 *
 * @param sequence - Identity sequence of the message.
 * @param body - The reply's parts, or its text as one text part.
 * @returns {@link buildCompletedAssistantMessage}'s reply, which the model
 * stopped, as {@link buildChatViewAssistantMessage} copies it.
 */
export function buildCompletedChatViewReply(
  sequence: number,
  body: string | readonly ReplyPart[]
): ChatViewAssistantMessageFixture<
  AssistantMessageFixture<"completed", "stop" | "length">
> {
  return buildChatViewAssistantMessage(
    buildCompletedAssistantMessage(sequence, body)
  )
}

/**
 * Builds a reply that ended without completing, as the chat view holds it.
 *
 * @param sequence - Identity sequence of the message.
 * @param body - Parts stored before it ended, or their text as one text
 * part.
 * @param status - Whether the reply was interrupted or failed.
 * @returns {@link buildEndedAssistantMessage}'s reply, as
 * {@link buildChatViewAssistantMessage} copies it.
 */
export function buildEndedChatViewReply(
  sequence: number,
  body: string | readonly ReplyPart[],
  status: "interrupted" | "failed"
): ChatViewAssistantMessageFixture<
  AssistantMessageFixture<"interrupted" | "failed", null>
> {
  return buildChatViewAssistantMessage(
    buildEndedAssistantMessage(sequence, body, status)
  )
}

/**
 * Builds stored conversation metadata answered by Caliginia, the built-in
 * agent a new conversation starts with.
 *
 * @param id - Conversation identity.
 * @param title - Stored title, or null before title generation saves one.
 * @returns Frozen metadata validated by the shared schema.
 */
export function buildConversationMetadata(
  id: string,
  title: string | null
): ConversationMetadata {
  return Object.freeze(
    conversationMetadataSchema.parse({
      id,
      title,
      agentCode: CALIGINIA_AGENT_CODE,
      createdAt: FIXTURE_TIMESTAMP,
      updatedAt: FIXTURE_TIMESTAMP
    })
  )
}

/**
 * Builds a stored conversation with its transcript.
 *
 * @param id - Conversation identity.
 * @param title - Stored title, or null before title generation saves one.
 * @param messages - Transcript in stored order.
 * @returns A frozen conversation without sources, validated by the shared
 * schema.
 */
export function buildConversation(
  id: string,
  title: string | null,
  messages: readonly ConversationMessage[]
): Conversation {
  return Object.freeze(
    conversationSchema.parse({
      ...buildConversationMetadata(id, title),
      messages,
      sources: []
    })
  )
}

/**
 * Builds a stored conversation that holds numbered sources.
 *
 * @param conversation - The conversation, such as {@link buildConversation}
 * builds it.
 * @param sources - Numbered sources the conversation stored, in number order.
 * @returns A frozen copy of the conversation holding the sources, validated
 * by the shared schema.
 */
export function buildConversationWithSources(
  conversation: Conversation,
  sources: readonly ConversationSource[]
): Conversation {
  return Object.freeze(conversationSchema.parse({ ...conversation, sources }))
}

/**
 * Builds the problem the backend sends for a conversation it does not store.
 *
 * @returns A problem body validated by the shared schema.
 */
export function buildConversationNotFoundProblem(): ConversationNotFoundProblem {
  return conversationNotFoundProblemSchema.parse({
    type: "urn:lys:problem:conversation:not-found",
    title: "Conversation not found",
    status: 404,
    detail: "No conversation is stored under this identifier."
  })
}

/**
 * Builds the problem the backend sends for a reply it does not store.
 *
 * @returns A problem body validated by the shared schema.
 */
export function buildReplyNotFoundProblem(): ChatReplyNotFoundProblem {
  return chatReplyNotFoundProblemSchema.parse({
    type: "urn:lys:problem:chat:reply-not-found",
    title: "Reply not found",
    status: 404,
    detail: "No reply is stored under this identifier."
  })
}

/**
 * Builds the problem the backend sends when no generation runs for a reply.
 *
 * @returns A problem body validated by the shared schema.
 */
export function buildReplyNotGeneratingProblem(): ChatReplyNotGeneratingProblem {
  return chatReplyNotGeneratingProblemSchema.parse({
    type: "urn:lys:problem:chat:reply-not-generating",
    title: "Reply not generating",
    status: 409,
    detail: "No generation is running for this reply."
  })
}

/**
 * Builds one conversation as the list endpoint summarizes it.
 *
 * @param id - Conversation identity.
 * @param title - Stored title, or null before title generation saves one.
 * @param preview - Message shown beneath the title, or null when none has
 * content.
 * @param updatedAt - Activity time that orders the list; defaults to
 * {@link FIXTURE_TIMESTAMP}.
 * @returns A frozen summary.
 */
export function buildConversationSummary(
  id: string,
  title: string | null,
  preview: ConversationPreview | null,
  updatedAt = FIXTURE_TIMESTAMP
): ConversationSummary {
  return Object.freeze({
    id,
    title,
    createdAt: FIXTURE_TIMESTAMP,
    updatedAt,
    preview
  })
}

/** Counts and continuation of one list page. */
export type ConversationListPageFixture = Readonly<{
  /** Stored conversations; defaults to the number listed. */
  storedCount?: number
  /** Conversations matching the query; defaults to the number listed. */
  matchCount?: number
  /** Continuation for the next page; defaults to null, the final page. */
  nextCursor?: string | null
}>

/**
 * Builds one page of the conversation list.
 *
 * @param conversations - Listed conversations in the documented order.
 * @param page - Counts and continuation the case depends on.
 * @returns A page validated by the shared list schema.
 */
export function buildConversationListPage(
  conversations: readonly ConversationSummary[],
  page: ConversationListPageFixture = {}
): ListConversationsApiResponse {
  return listConversationsApi.response.parse({
    conversations,
    storedCount: page.storedCount ?? conversations.length,
    matchCount: page.matchCount ?? conversations.length,
    nextCursor: page.nextCursor ?? null
  })
}
