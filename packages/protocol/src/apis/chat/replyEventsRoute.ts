import { conversationAssistantMessageSchema } from "@lys/share"
import * as z from "zod"
import { chatReplyNotFoundProblemSchema } from "../../http/errors/chat"
import { conversationNotFoundProblemSchema } from "../../http/errors/conversation"
import {
  chatDeltaEventSchema,
  chatDoneEventSchema,
  chatErrorEventSchema,
  chatInterruptedEventSchema,
  chatReplyPathParamsSchema,
  chatTitleEventSchema,
  chatToolCallEventSchema,
  chatToolCallSchema,
  type ChatReplyPathParams
} from "./_share"
import { apiChatReplyEventsRoute } from "./routes"

/**
 * Validates the event that starts every reply-events stream.
 *
 * @remarks The reply includes every delta sent to any follower before this
 * event, so later `delta` events continue from exactly its content.
 */
const chatReplySnapshotEventSchema = z.strictObject({
  type: z.literal("reply-snapshot"),
  /** Stored conversation title when the snapshot was read; null while untitled. */
  conversationTitle: z.string().min(1).nullable(),
  /** Stored reply, including every delta sent to followers before this event. */
  assistantMessage: conversationAssistantMessageSchema,
  /**
   * Tool calls sent and not yet answered when the snapshot was read, in the
   * order sent; empty when the reply is not generating. Each pending call
   * reaches a follower once: here or as a later `tool-call` event.
   */
  pendingToolCalls: z.array(chatToolCallSchema).readonly()
})

/**
 * Validates the SSE events sent to a client that follows one stored reply.
 *
 * @remarks The first event is always `reply-snapshot`. When no generation
 * runs for the reply, the stream closes right after the snapshot. Otherwise
 * the generation events follow and the stream closes after the generation
 * settles; like every generation stream (see `ChatGenerationEvent`), it can
 * close without a final reply event.
 */
export const chatReplyEventSchema = z.discriminatedUnion("type", [
  chatReplySnapshotEventSchema,
  chatTitleEventSchema,
  chatDeltaEventSchema,
  chatDoneEventSchema,
  chatInterruptedEventSchema,
  chatErrorEventSchema,
  chatToolCallEventSchema
])

/** Typed event union accepted by the reply-events SSE transport. */
export type ChatReplyEvent = z.infer<typeof chatReplyEventSchema>

/** Success representation of the reply-events endpoint. */
const chatReplyEventsApiResponse = Object.freeze({
  status: 200,
  contentType: "text/event-stream",
  eventSchema: chatReplyEventSchema
})

/** Selects the reply-events failure validator by HTTP status. */
const chatReplyEventsApiResponseSchemas = Object.freeze({
  404: z.union([
    conversationNotFoundProblemSchema,
    chatReplyNotFoundProblemSchema
  ])
})

/**
 * Describes the GET endpoint that follows one assistant reply over SSE.
 *
 * @remarks A 200 response is an event stream validated by
 * {@link chatReplyEventSchema}. Following never changes the reply: closing
 * the stream ends only this client's observation. A missing conversation
 * returns the conversation-not-found problem and a conversation without the
 * addressed reply returns the reply-not-found problem, both with HTTP 404
 * before the stream starts. There is no replay: a client that reconnects
 * receives a new snapshot. Changing the method, path, or schemas requires
 * coordinated consumers.
 */
export const chatReplyEventsApi = Object.freeze({
  method: "GET",
  path: apiChatReplyEventsRoute,
  params: chatReplyPathParamsSchema,
  response: chatReplyEventsApiResponse,
  responses: chatReplyEventsApiResponseSchemas
})

/** Fastify route type for the reply-events endpoint. */
export type ChatReplyEventsApiRoute = {
  /** Validated identifiers of the followed reply. */
  readonly Params: ChatReplyPathParams
}
