import type {
  ConversationSummary,
  ListConversationsApiResponse
} from "@lys/protocol"
import type {
  Conversation,
  ConversationAssistantMessage,
  ConversationUserMessage
} from "@lys/share"

/** Synthetic UUIDv7 identities used across conversation fixtures. */
export const FIXTURE_IDS = Object.freeze({
  firstConversation: "01990000-0000-7000-8000-000000000001",
  secondConversation: "01990000-0000-7000-8000-000000000002",
  thirdConversation: "01990000-0000-7000-8000-000000000003",
  userMessage: "01990000-0000-7000-8000-0000000000a1",
  assistantMessage: "01990000-0000-7000-8000-0000000000a2",
  laterUserMessage: "01990000-0000-7000-8000-0000000000a3"
})

/** Fixed ISO timestamp with the millisecond precision the schemas require. */
export const FIXTURE_TIMESTAMP = "2026-09-11T10:00:00.000Z"

/** Values a test chooses for one listed conversation. */
type ConversationSummaryFixture = {
  /** UUIDv7 identity of the listed conversation. */
  readonly id: string
  /** Stored title, or null before one is generated. */
  readonly title: string | null
  /** ISO activity time ordering the entry. */
  readonly updatedAt: string
  /** Previewed message, or null when none has content. */
  readonly preview: ConversationSummary["preview"]
}

/**
 * Builds one valid listed conversation.
 *
 * @param fixture - Identity, title, activity time, and preview under test.
 * @returns A summary whose creation time is the fixed fixture timestamp.
 */
export function buildConversationSummary(
  fixture: ConversationSummaryFixture
): ConversationSummary {
  return {
    id: fixture.id,
    title: fixture.title,
    createdAt: FIXTURE_TIMESTAMP,
    updatedAt: fixture.updatedAt,
    preview: fixture.preview
  }
}

/** Counts and continuation a test chooses for one list page. */
type ListPageFixture = {
  /** Listed conversations in backend order. */
  readonly conversations: readonly ConversationSummary[]
  /** Stored conversations independent of the query. */
  readonly storedCount: number
  /** Stored conversations matching the query. */
  readonly matchCount: number
  /** Continuation, or null for the final page. */
  readonly nextCursor: string | null
}

/**
 * Builds one list page as the backend transmits it.
 *
 * @param fixture - Conversations, counts, and continuation under test.
 * @returns A mutable wire-shaped page, as decoded JSON would be.
 */
export function buildListPage(
  fixture: ListPageFixture
): ListConversationsApiResponse {
  return {
    conversations: [...fixture.conversations],
    storedCount: fixture.storedCount,
    matchCount: fixture.matchCount,
    nextCursor: fixture.nextCursor
  }
}

/**
 * Builds one stored user message.
 *
 * @param id - UUIDv7 identity of the message.
 * @param content - Non-empty authored text.
 * @returns A valid user message created at the fixture timestamp.
 */
export function buildUserMessage(
  id: string,
  content: string
): ConversationUserMessage {
  return { id, createdAt: FIXTURE_TIMESTAMP, role: "user", content }
}

/** Lifecycle a test chooses for one stored assistant message. */
type AssistantMessageFixture = {
  /** UUIDv7 identity of the message. */
  readonly id: string
  /** Stored reply text. */
  readonly content: string
  /** Stored lifecycle status. */
  readonly status: ConversationAssistantMessage["status"]
  /** Stored finish reason paired with the status. */
  readonly finishReason: ConversationAssistantMessage["finishReason"]
}

/**
 * Builds one stored assistant message.
 *
 * @param fixture - Identity, content, and lifecycle under test.
 * @returns An assistant message from a fixed model at the fixture timestamp.
 */
export function buildAssistantMessage(
  fixture: AssistantMessageFixture
): ConversationAssistantMessage {
  return {
    id: fixture.id,
    createdAt: FIXTURE_TIMESTAMP,
    model: "fixture/model",
    role: "assistant",
    content: fixture.content,
    status: fixture.status,
    finishReason: fixture.finishReason,
    updatedAt: FIXTURE_TIMESTAMP
  }
}

/**
 * Builds one stored conversation as the get endpoint transmits it.
 *
 * @param id - UUIDv7 identity of the conversation.
 * @param messages - Stored messages in persisted order.
 * @returns A titled conversation with a fixed system prompt and timestamps.
 */
export function buildStoredConversation(
  id: string,
  messages: Conversation["messages"]
): Conversation {
  return {
    id,
    title: "Stored conversation",
    systemPrompt: "You are Lys.",
    messages: [...messages],
    createdAt: FIXTURE_TIMESTAMP,
    updatedAt: FIXTURE_TIMESTAMP
  }
}

/**
 * Creates a JSON HTTP response.
 *
 * @param body - Value serialized as the response body.
 * @param status - HTTP status of the response.
 * @returns A response declaring `application/json`.
 */
export function createJsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  })
}

/**
 * Creates the missing-conversation Problem Details response.
 *
 * @returns A 404 response carrying the declared problem body.
 */
export function createConversationNotFoundResponse(): Response {
  return createJsonResponse(
    {
      type: "urn:lys:problem:conversation:not-found",
      title: "Conversation not found",
      status: 404,
      detail: "The conversation was not found."
    },
    404
  )
}

/** Promise with externally controlled settlement for ordering tests. */
export type Deferred<TValue> = {
  /** Promise settled only through `resolve` or `reject`. */
  readonly promise: Promise<TValue>
  /** Fulfills the promise. */
  readonly resolve: (value: TValue) => void
  /** Rejects the promise. */
  readonly reject: (reason: unknown) => void
}

/**
 * Creates a promise the test settles explicitly.
 *
 * @returns The pending promise and its settlement functions.
 */
export function createDeferred<TValue>(): Deferred<TValue> {
  let resolve: (value: TValue) => void = () => undefined
  let reject: (reason: unknown) => void = () => undefined
  const promise = new Promise<TValue>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })

  return { promise, resolve, reject }
}
