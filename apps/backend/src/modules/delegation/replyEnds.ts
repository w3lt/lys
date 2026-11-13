import type { EndedActivityStatus } from "../activity/activityHub"
import type { EndedReply } from "../chat/turnStart"
import type { DelegationRuntime } from "./dependencies"
import type { EndedReplyRecord } from "./records"

/** What {@link handleReplyEnded} uses of the delegation runtime. */
export type ReplyEndRuntime = Pick<
  DelegationRuntime,
  "stopRequests" | "jobActivity" | "jobs" | "hub"
>

/**
 * Handles the end of a reply of a turn started with the delegation hooks:
 * a person's turn, or a turn delegation started.
 *
 * @param runtime - The stop requests, the job and reply readers, and the
 * hub.
 * @param reply - The reply that ended, after its final state was stored.
 * @throws If the job store is closed or holds an invalid value.
 * @remarks Forgets who asked the reply to stop, removes the reply from the
 * hub with its stored final state, and, for a reply of a job, sends the
 * job's update. A reply that is no longer stored, because its conversation
 * was deleted, is removed with `null`, and no update is sent. A reply still
 * stored as `streaming`, because its final state could not be written, is
 * removed as `interrupted`, the state startup recovery stores for it. The
 * hub ignores a reply it does not follow, such as the person's own.
 */
export function handleReplyEnded(
  runtime: ReplyEndRuntime,
  reply: EndedReply
): void {
  runtime.stopRequests.removeStopRequest(reply.assistantMessageId)
  const ended = runtime.jobActivity.findEndedReply(reply.assistantMessageId)
  runtime.hub.removeReply(
    reply.assistantMessageId,
    calculateEndedActivityStatus(ended)
  )
  if (ended === undefined || ended.parentConversationId === null) return
  const record = runtime.jobs.findJob(ended.conversationId)
  if (record !== undefined)
    runtime.hub.sendJobUpdate(record.parentConversationId, record.job)
}

/**
 * Calculates the final state the activity streams are told a reply ended
 * in.
 *
 * @param ended - The reply as stored; undefined when it is no longer stored.
 * @returns The stored final state; `interrupted` for a reply still stored as
 * `streaming`; null for a reply that is no longer stored.
 */
function calculateEndedActivityStatus(
  ended: EndedReplyRecord | undefined
): EndedActivityStatus | null {
  if (ended === undefined) return null
  return ended.status === "streaming" ? "interrupted" : ended.status
}
