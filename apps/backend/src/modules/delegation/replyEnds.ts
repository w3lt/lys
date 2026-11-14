import { v7 as uuidv7 } from "uuid"
import type { EndedActivityStatus } from "../activity/activityHub"
import type { EndedReply } from "../chat/turnStart"
import type { DelegationRuntime } from "./dependencies"
import { buildEndReport } from "./endReports"
import type { EndedReplyRecord, EndReportKind, NewEndReport } from "./records"
import type { StopRequester } from "./replyStopRequests"
import { startDueWakeUpTurn, type WakeUpRuntime } from "./wakeUps"

/** What {@link handleReplyEnded} uses of the delegation runtime. */
export type ReplyEndRuntime = WakeUpRuntime &
  Pick<DelegationRuntime, "stopRequests" | "reports">

/** The end of a reply of a job, with what it is handled with. */
type JobReplyEnding = Readonly<{
  /** The reply that ended, as its turn start tells it. */
  reply: EndedReply
  /** The reply as stored once its end is reported. */
  record: EndedReplyRecord
  /** Who asked the reply to stop; undefined when nobody did. */
  requester: StopRequester | undefined
}>

/** The end of a reply once it was saved and the reply left the hub. */
type SavedReplyEnd = Readonly<{
  /** The reply as stored once its end is reported. */
  record: EndedReplyRecord
  /** The final state the activity streams were told. */
  status: EndedActivityStatus
  /**
   * Kind of the end report stored for a job's reply; undefined for a reply
   * of a main conversation, or when no report was stored.
   */
  reportKind: EndReportKind | undefined
}>

/**
 * Handles the end of a reply of a turn started with the delegation hooks:
 * a person's turn, a job's turn, or a wake-up turn.
 *
 * @param runtime - The stop requests, the job and reply readers, the report
 * writer, the wake settings, what a wake-up turn is started with, the hub,
 * and the event reporter.
 * @param reply - The reply that ended, after its final state was stored.
 * @throws If a store is closed or fails, or a stored value violates its
 * contract; or what the turn start throws when a wake-up reply cannot
 * start, as {@link startDueWakeUpTurn} describes. The reply has left the
 * hub all the same, as {@link saveReplyEnd} describes; when the reply could
 * not be read or its end report could not be stored, no job update is sent,
 * no wake-up starts, and the wake settings stay as they are.
 * @remarks Forgets who asked the reply to stop first, then saves the end
 * as {@link saveReplyEnd} does. A reply that is no longer stored, because
 * its conversation was deleted, has nothing else happen. Otherwise the end
 * is handled as {@link handleMainReplyEnded} describes for a reply of a
 * main conversation, and as {@link handleJobReplyEnded} describes for a
 * reply of a job. Last, the wake settings of the main conversation the
 * reply belongs or reports to are removed when
 * {@link removeIdleWakeSettings} finds them idle.
 */
export function handleReplyEnded(
  runtime: ReplyEndRuntime,
  reply: EndedReply
): void {
  const requester = runtime.stopRequests.removeStopRequest(
    reply.assistantMessageId
  )
  const saved = saveReplyEnd(runtime, reply, requester)
  if (saved === undefined) return
  const { record } = saved
  if (record.parentConversationId === null) handleMainReplyEnded(runtime, saved)
  else handleJobReplyEnded(runtime, saved)
  removeIdleWakeSettings(
    runtime,
    record.parentConversationId ?? record.conversationId
  )
}

/**
 * Saves the end of a reply: reads the reply as stored, stores the end
 * report of a job's reply, and takes the reply out of the hub.
 *
 * @param runtime - The reply reader, the job reader, the report writer, the
 * hub, and the event reporter.
 * @param reply - The reply that ended.
 * @param requester - Who asked the reply to stop; undefined when nobody
 * did.
 * @returns The stored reply, the status the hub was told, and the kind of
 * the stored end report; undefined when the reply is no longer stored.
 * @throws If the reply cannot be read, or the job or report store is closed
 * or the write fails. The reply has left the hub then all the same.
 * @remarks The report is stored as {@link saveEndReport} stores it, before
 * the reply leaves the hub. The reply leaves the hub in every case, so no
 * stream lists it after its end: with its stored final state once it was
 * read, and `null` when it is no longer stored or could not be read. A
 * reply still stored as `streaming`, because its final state could not be
 * written, leaves as `interrupted`, the state startup recovery stores for
 * it, and gets no end report. The hub ignores a reply it does not follow,
 * such as the person's own.
 */
function saveReplyEnd(
  runtime: Pick<
    ReplyEndRuntime,
    "jobActivity" | "jobs" | "reports" | "reportEvent" | "hub"
  >,
  reply: EndedReply,
  requester: StopRequester | undefined
): SavedReplyEnd | undefined {
  let endedStatus: EndedActivityStatus | null = null
  try {
    const record = runtime.jobActivity.findEndedReply(reply.assistantMessageId)
    if (record === undefined) return undefined
    endedStatus = calculateEndedActivityStatus(record)
    const reportKind =
      record.parentConversationId === null
        ? undefined
        : saveEndReport(runtime, Object.freeze({ reply, record, requester }))
    return Object.freeze({ record, status: endedStatus, reportKind })
  } finally {
    runtime.hub.removeReply(reply.assistantMessageId, endedStatus)
  }
}

/**
 * Handles the end of a reply of a main conversation, the person's reply or
 * that of a wake-up turn, once the reply left the hub.
 *
 * @param runtime - What a wake-up turn is started with.
 * @param saved - The stored reply and the status the hub was told.
 * @throws As {@link handleReplyEnded} does.
 * @remarks A reply that completed or failed starts the wake-up turn its
 * conversation is due, as {@link startDueWakeUpTurn} decides, so the
 * reports that arrived while it streamed reach the agent. A reply that was
 * interrupted starts nothing: whoever stopped it decides what comes next.
 */
function handleMainReplyEnded(
  runtime: ReplyEndRuntime,
  saved: SavedReplyEnd
): void {
  if (saved.status === "completed" || saved.status === "failed")
    startDueWakeUpTurn(runtime, saved.record.conversationId)
}

/**
 * Handles the end of a reply of a job once its report was stored and the
 * reply left the hub: tells the hub how the job changed, and wakes the
 * delegator when the report calls for it.
 *
 * @param runtime - The job reader, the hub, and what a wake-up turn is
 * started with.
 * @param saved - The stored reply and the kind of its stored end report.
 * @throws As {@link handleReplyEnded} does.
 * @remarks The job's update, read once the report is stored, is sent. A
 * `result` or a `failed` report stored for the reply then starts the
 * wake-up turn the delegator's conversation is due, as
 * {@link startDueWakeUpTurn} decides; no other report does. A job that is
 * no longer stored gets no update.
 */
function handleJobReplyEnded(
  runtime: ReplyEndRuntime,
  saved: SavedReplyEnd
): void {
  const ended = runtime.jobs.findJob(saved.record.conversationId)
  if (ended === undefined) return
  runtime.hub.sendJobUpdate(ended.parentConversationId, ended.job)
  if (saved.reportKind === "result" || saved.reportKind === "failed")
    startDueWakeUpTurn(runtime, ended.parentConversationId)
}

/**
 * Stores the report that tells a job's delegator how a reply of the job
 * ended.
 *
 * @param runtime - The job reader, the report writer, and the event
 * reporter.
 * @param ending - The reply, its stored record, and who asked it to stop.
 * @returns The kind of the stored report; undefined when nothing was
 * stored: the reply's end gives no report, as {@link buildEndReport}
 * decides, the job is no longer stored, or the reply already has an end
 * report.
 * @throws If the job or report store is closed or the write fails.
 * @remarks The report carries the job's title as it is now, the title of
 * the job message the reply answers, and the time the clock is read once
 * here. Once it is stored, `report-stored` is reported for the delegator's
 * conversation.
 */
function saveEndReport(
  runtime: Pick<ReplyEndRuntime, "jobs" | "reports" | "reportEvent">,
  ending: JobReplyEnding
): EndReportKind | undefined {
  const { reply, record, requester } = ending
  const report = buildEndReport(record, requester, reply.errorMessage)
  if (report === undefined) return undefined
  const found = runtime.jobs.findJob(record.conversationId)
  if (found === undefined) return undefined
  const createdAt = new Date().toISOString()
  const endReport: NewEndReport = {
    id: uuidv7(),
    jobId: found.job.id,
    replyId: reply.assistantMessageId,
    kind: report.kind,
    title: found.job.title,
    content: report.content,
    createdAt
  }
  if (!runtime.reports.createEndReport(endReport)) return undefined
  runtime.reportEvent({
    kind: "report-stored",
    conversationId: found.parentConversationId,
    jobId: found.job.id,
    jobNumber: found.job.number,
    reportKind: report.kind
  })
  return report.kind
}

/**
 * Removes the wake settings of a delegator's conversation once no wake-up
 * turn of it can be due any more.
 *
 * @param runtime - The wake settings, the job reader, and the reply reader.
 * @param conversationId - UUIDv7 of the delegator's main conversation.
 * @throws If the job store is closed or a stored job violates the job
 * contract.
 * @remarks The settings are kept while a job of the conversation works,
 * since its report may wake the delegator, and while a `result` or `failed`
 * report waits to be delivered, since the wake-up turn that delivers it may
 * still start. A conversation without wake settings is left as it is,
 * without reading its jobs.
 */
function removeIdleWakeSettings(
  runtime: Pick<ReplyEndRuntime, "wakeSettings" | "jobs" | "jobActivity">,
  conversationId: string
): void {
  const lookup = runtime.wakeSettings.findWakeSettings(conversationId)
  if (lookup.status !== "found") return
  const hasWorkingJob = runtime.jobs
    .listJobs(conversationId)
    .some((job) => job.state === "working")
  if (hasWorkingJob) return
  if (runtime.jobActivity.hasUndeliveredWakingReport(conversationId)) return
  runtime.wakeSettings.removeWakeSettings(conversationId)
}

/**
 * Calculates the final state the activity streams are told a reply ended
 * in.
 *
 * @param record - The reply as stored once its end is reported.
 * @returns The stored final state; `interrupted` for a reply still stored as
 * `streaming`.
 */
function calculateEndedActivityStatus(
  record: EndedReplyRecord
): EndedActivityStatus {
  return record.status === "streaming" ? "interrupted" : record.status
}
