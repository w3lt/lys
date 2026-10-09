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
  conversationAssistantMessageSchema,
  conversationMetadataSchema,
  conversationSchema,
  conversationUserMessageSchema,
  type Conversation,
  type ConversationAssistantMessage,
  type ConversationMessage,
  type ConversationMetadata,
  type ConversationUserMessage
} from "@lys/share"

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

/**
 * Builds the shared fields of an assistant message from {@link FIXTURE_MODEL}.
 *
 * @param sequence - Identity sequence of the message.
 * @param content - Stored reply text, possibly empty.
 * @returns The fields that do not depend on the lifecycle.
 */
function buildAssistantMessageBase(sequence: number, content: string) {
  return {
    id: createFixtureUuidV7(sequence),
    role: "assistant" as const,
    model: FIXTURE_MODEL,
    content,
    createdAt: FIXTURE_TIMESTAMP,
    updatedAt: FIXTURE_TIMESTAMP
  }
}

/**
 * Builds an assistant message whose generation is still running.
 *
 * @param sequence - Identity sequence of the message.
 * @param content - Reply text received so far, possibly empty.
 * @returns A frozen streaming reply validated by the shared schema.
 */
export function buildStreamingAssistantMessage(
  sequence: number,
  content: string
): AssistantMessageFixture<"streaming", null> {
  return buildValidatedAssistantMessage({
    ...buildAssistantMessageBase(sequence, content),
    status: "streaming" as const,
    finishReason: null
  })
}

/**
 * Builds an assistant message the model completed.
 *
 * @param sequence - Identity sequence of the message.
 * @param content - Complete reply text.
 * @param finishReason - Reason the model stopped; defaults to `stop`.
 * @returns A frozen completed reply validated by the shared schema.
 */
export function buildCompletedAssistantMessage(
  sequence: number,
  content: string,
  finishReason: "stop" | "length" = "stop"
): AssistantMessageFixture<"completed", "stop" | "length"> {
  return buildValidatedAssistantMessage({
    ...buildAssistantMessageBase(sequence, content),
    status: "completed" as const,
    finishReason
  })
}

/**
 * Builds an assistant message whose generation ended without completing.
 *
 * @param sequence - Identity sequence of the message.
 * @param content - Reply text stored before it ended.
 * @param status - Whether the reply was interrupted or failed.
 * @returns A frozen ended reply validated by the shared schema.
 */
export function buildEndedAssistantMessage(
  sequence: number,
  content: string,
  status: "interrupted" | "failed"
): AssistantMessageFixture<"interrupted" | "failed", null> {
  return buildValidatedAssistantMessage({
    ...buildAssistantMessageBase(sequence, content),
    status,
    finishReason: null
  })
}

/**
 * Builds stored conversation metadata answered by the `lys` agent.
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
      agentCode: "lys",
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
 * @returns A frozen conversation validated by the shared schema.
 */
export function buildConversation(
  id: string,
  title: string | null,
  messages: readonly ConversationMessage[]
): Conversation {
  return Object.freeze(
    conversationSchema.parse({
      ...buildConversationMetadata(id, title),
      messages
    })
  )
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
