import {
  conversationAssistantMessageSchema,
  jobSchema,
  toolCallReplyPartStatusSchema
} from "@lys/share"
import * as z from "zod"
import {
  chatToolApprovalPromptSchema,
  chatToolApprovalTokenSchema,
  chatToolCallSchema
} from "../chat/_share"
import { apiActivityEventsRoute } from "./routes"

/**
 * Fields that name one reply the backend started: a job's reply, or a
 * wake-up reply of a main conversation.
 */
const activityReplyTargetShape = {
  /** UUIDv7 identity of the conversation that holds the reply. */
  conversationId: z.uuidv7(),
  /**
   * UUIDv7 identity of that conversation's parent; null for a wake-up reply,
   * whose conversation is a main one.
   */
  parentConversationId: z.uuidv7().nullable(),
  /** UUIDv7 identity of the reply. */
  assistantMessageId: z.uuidv7()
}

/**
 * Validates one backend-started reply generating now, with what it waits
 * for.
 */
export const activityReplySchema = z.strictObject({
  ...activityReplyTargetShape,
  /** Desktop tool calls sent to run and not answered, in the order sent. */
  pendingToolCalls: z.array(chatToolCallSchema).readonly(),
  /**
   * Approval prompts sent and not answered, in the order sent, each with the
   * token its answer must carry.
   */
  pendingToolApprovals: z.array(chatToolApprovalPromptSchema).readonly()
})

/** One backend-started reply generating now, with what it waits for. */
export type ActivityReply = z.infer<typeof activityReplySchema>

/** Validates the event that starts every activity stream. */
const activitySnapshotEventSchema = z.strictObject({
  type: z.literal("activity-snapshot"),
  /** Every backend-started reply generating when the snapshot was built. */
  replies: z.array(activityReplySchema).readonly()
})

/**
 * Validates the event reporting that a job's reply or a wake-up reply
 * started.
 */
const activityReplyStartedEventSchema = z.strictObject({
  type: z.literal("reply-started"),
  ...activityReplyTargetShape
})

/**
 * Validates the event reporting that a backend-started reply ended.
 *
 * @remarks It ends every pending tool call and approval prompt of that
 * reply.
 */
const activityReplyEndedEventSchema = z.strictObject({
  type: z.literal("reply-ended"),
  ...activityReplyTargetShape,
  /**
   * Final state of the reply: the stored one, or `interrupted` for a reply
   * still stored as `streaming` because its final state could not be
   * written, the state startup recovery stores for it; null when it is no
   * longer stored or could not be read.
   */
  status: conversationAssistantMessageSchema.shape.status
    .exclude(["streaming"])
    .nullable()
})

/**
 * Validates the event reporting one job in its current state.
 *
 * @remarks It carries the whole job, so a newer event replaces an older one
 * of the same job.
 */
const activityJobUpdatedEventSchema = z.strictObject({
  type: z.literal("job-updated"),
  /** UUIDv7 identity of the conversation the job was started from. */
  parentConversationId: z.uuidv7(),
  /** The whole job as it is now. */
  job: jobSchema
})

/**
 * Validates the event asking a client to show the person one call of a
 * backend-started reply for approval.
 */
const activityToolApprovalEventSchema = z.strictObject({
  type: z.literal("tool-approval"),
  ...activityReplyTargetShape,
  /** Call the person allows or rejects through the tool-approval endpoint. */
  call: chatToolCallSchema,
  /** Single-use token the answer to this prompt must carry. */
  approvalToken: chatToolApprovalTokenSchema
})

/**
 * Validates the event reporting that one approval prompt of a
 * backend-started reply ended before the reply did.
 *
 * @remarks Sent once for each prompt the reply sent as `tool-approval`,
 * when the reply first stores its call in another state than waiting for
 * approval; a client that found the prompt in its snapshot receives it too.
 * A prompt that ended while a client was not connected is only left out of
 * that client's next snapshot, which does not say how it ended.
 */
const activityToolApprovalEndedEventSchema = z.strictObject({
  type: z.literal("tool-approval-ended"),
  ...activityReplyTargetShape,
  /**
   * UUIDv7 identity of the call whose prompt ended, as its `tool-approval`
   * carried it.
   */
  callId: z.uuidv7(),
  /**
   * State the reply stored the call in when its prompt ended: `running` once
   * it was allowed, `rejected` once it was rejected, and `failed` when nobody
   * answered within the prompt's time limit.
   */
  status: toolCallReplyPartStatusSchema.extract([
    "running",
    "rejected",
    "failed"
  ])
})

/**
 * Validates the event asking a client to run one call of a client tool for a
 * backend-started reply.
 */
const activityToolCallEventSchema = z.strictObject({
  type: z.literal("tool-call"),
  ...activityReplyTargetShape,
  /** Call the client runs and answers through the tool-result endpoint. */
  call: chatToolCallSchema
})

/**
 * Validates the SSE events of the activity stream, selected by `type`.
 *
 * @remarks The first event is always `activity-snapshot`. Each event is
 * delivered at most once. A call can be in the snapshot and arrive again as
 * a `tool-approval` or `tool-call` event, so a client merges calls by
 * `call.id`. Each snapshot is authoritative for the replies it lists: a
 * prompt of a listed reply that it does not list no longer waits.
 * `tool-approval-ended` ends one prompt, and `reply-ended` ends every
 * pending call of that reply. Answers go to the existing tool-approval and
 * tool-result endpoints with the event's `conversationId` and
 * `assistantMessageId`.
 */
export const activityEventSchema = z.discriminatedUnion("type", [
  activitySnapshotEventSchema,
  activityReplyStartedEventSchema,
  activityReplyEndedEventSchema,
  activityJobUpdatedEventSchema,
  activityToolApprovalEventSchema,
  activityToolApprovalEndedEventSchema,
  activityToolCallEventSchema
])

/** Typed event union accepted by the activity SSE transport. */
export type ActivityEvent = z.infer<typeof activityEventSchema>

/** Success representation of the activity-events endpoint. */
const activityEventsApiResponse = Object.freeze({
  status: 200,
  contentType: "text/event-stream",
  eventSchema: activityEventSchema
})

/**
 * Describes the GET endpoint that follows, over SSE, the replies the backend
 * started and the jobs they belong to.
 *
 * @remarks A 200 response is an event stream validated by
 * {@link activityEventSchema}. The stream never ends by itself: it closes
 * when the backend shuts down or the client falls too far behind. There is
 * no replay: a new connection starts with a new snapshot. Following changes
 * nothing, and closing the stream ends only this client's observation.
 * Changing the method, path, or schemas requires coordinated consumers.
 */
export const activityEventsApi = Object.freeze({
  method: "GET",
  path: apiActivityEventsRoute,
  response: activityEventsApiResponse
})
