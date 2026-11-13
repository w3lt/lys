import {
  activityEventSchema,
  activityReplySchema,
  type ActivityReply,
  type ChatToolCall
} from "@lys/protocol"
import { startBackendEventStream, type BackendRoute } from "./backendFake"
import {
  FIXTURE_CONVERSATION_ID,
  FIXTURE_JOB_ID,
  FIXTURE_JOB_REPLY_ID
} from "./conversationFixtures"

/** Route key of the activity stream. */
export const ACTIVITY_ROUTE = "GET /api/v1/activity/events"

/**
 * Calls a case may list for the job's reply, which is always
 * {@link FIXTURE_JOB_REPLY_ID} of {@link FIXTURE_JOB_ID} under
 * {@link FIXTURE_CONVERSATION_ID}.
 */
export type ActivityReplyFixture = Readonly<{
  /**
   * Approval prompts sent and not answered, in sending order; defaults to
   * none.
   */
  pendingToolApprovals?: readonly ChatToolCall[]
  /**
   * Desktop tool calls sent to run and not answered, in sending order;
   * defaults to none.
   */
  pendingToolCalls?: readonly ChatToolCall[]
}>

/**
 * Builds the job's reply as an activity snapshot lists it.
 *
 * @param fixture - Calls the reply waits for; see
 * {@link ActivityReplyFixture} for their defaults.
 * @returns A frozen reply validated by the shared schema.
 */
export function buildActivityReply(
  fixture: ActivityReplyFixture = {}
): ActivityReply {
  return Object.freeze(
    activityReplySchema.parse({
      conversationId: FIXTURE_JOB_ID,
      parentConversationId: FIXTURE_CONVERSATION_ID,
      assistantMessageId: FIXTURE_JOB_REPLY_ID,
      pendingToolCalls: fixture.pendingToolCalls ?? [],
      pendingToolApprovals: fixture.pendingToolApprovals ?? []
    })
  )
}

/**
 * Builds the activity route of a case that does not follow activity.
 *
 * @returns A route that answers every request with its own stream, which
 * sent a snapshot without replies and stays open until the client cancels it
 * or the case finishes.
 */
export function buildIdleActivityRoute(): BackendRoute {
  const snapshot = activityEventSchema.parse({
    type: "activity-snapshot",
    replies: []
  })
  return () => {
    const stream = startBackendEventStream()
    stream.sendEvent(snapshot)
    return stream.response
  }
}
