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

/** Lifecycle fields that distinguish assistant-message fixtures. */
export type AssistantMessageFixtureState =
  | Readonly<{ status: "completed"; finishReason: "stop" | "length" }>
  | Readonly<{ status: "streaming" | "interrupted" | "failed" }>

/**
 * Builds a stored assistant message.
 *
 * @param sequence - Identity sequence of the message.
 * @param content - Stored reply text, possibly empty.
 * @param state - Lifecycle status and, for completed replies, finish reason.
 * @returns A frozen assistant message from {@link FIXTURE_MODEL}, validated by
 * the shared schema.
 */
export function buildAssistantMessage(
  sequence: number,
  content: string,
  state: AssistantMessageFixtureState
): ConversationAssistantMessage {
  return Object.freeze(
    conversationAssistantMessageSchema.parse({
      id: createFixtureUuidV7(sequence),
      role: "assistant",
      model: FIXTURE_MODEL,
      content,
      status: state.status,
      finishReason: state.status === "completed" ? state.finishReason : null,
      createdAt: FIXTURE_TIMESTAMP,
      updatedAt: FIXTURE_TIMESTAMP
    })
  )
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
