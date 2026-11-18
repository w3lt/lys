import { v7 as uuidv7 } from "uuid"
import type { ProgressNoteOutcome } from "../agent/turnDelegation"
import type { TurnDelegationContext } from "../chat/turnStart"
import type { DelegationRuntime } from "./dependencies"
import type { NewProgressNote } from "./records"

/** What {@link createProgressNote} uses of the delegation runtime. */
export type ProgressNoteRuntime = Pick<
  DelegationRuntime,
  "jobs" | "reports" | "hub" | "reportEvent"
>

/**
 * Stores a progress note of a job's turn for the job's delegator, in place of
 * the job's notes the delegator has not read yet.
 *
 * @param runtime - The job reader, the report writer, the hub, and the event
 * reporter.
 * @param context - The job's turn, whose reply sends the note.
 * @param note - Trimmed, non-empty text of the note.
 * @returns `stored` once the note is stored; `job-missing` when the turn's
 * conversation is no longer a stored job, or its reply is no longer a reply
 * of the job, which stores nothing.
 * @throws If the job or report store is closed or the write fails.
 * @remarks The note carries the job's title as it is now, the title of the
 * job message the reply answers, and the time the clock is read once here.
 * Once it is stored, the job's update, with the note as its latest one, is
 * sent to the hub, and `report-stored` is reported for the delegator's
 * conversation.
 */
export function createProgressNote(
  runtime: ProgressNoteRuntime,
  context: TurnDelegationContext,
  note: string
): ProgressNoteOutcome {
  const jobId = context.turn.conversation.id
  const record = runtime.jobs.findJob(jobId)
  if (record === undefined) return "job-missing"
  const createdAt = new Date().toISOString()
  const progressNote: NewProgressNote = {
    id: uuidv7(),
    jobId,
    replyId: context.turn.assistantMessage.id,
    title: record.job.title,
    content: note,
    createdAt
  }
  if (!runtime.reports.createProgressNote(progressNote)) return "job-missing"
  const updated = runtime.jobs.findJob(jobId)
  if (updated !== undefined)
    runtime.hub.sendJobUpdate(updated.parentConversationId, updated.job)
  runtime.reportEvent({
    kind: "report-stored",
    conversationId: record.parentConversationId,
    jobId,
    jobNumber: record.job.number,
    reportKind: "note"
  })
  return "stored"
}
