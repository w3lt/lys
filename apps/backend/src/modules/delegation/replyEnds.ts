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
 * start, as {@link startDueWakeUpTurn} describes.
 * @remarks Forgets who asked the reply to stop first. A reply that is no
 * longer stored, because its conversation was deleted, is removed from the
 * hub with `null`, and nothing else happens. A reply still stored as
 * `streaming`, because its final state could not be written, is removed
 * from the hub as `interrupted`, the state startup recovery stores for it,
 * and gets no end report. Otherwise the end is handled as
 * {@link handleMainReplyEnded} describes for a reply of a main
 * conversation, and as {@link handleJobReplyEnded} describes for a reply of
 * a job. Last, the wake settings of the main conversation the reply belongs
 * or reports to are removed when {@link removeIdleWakeSettings} finds them
 * idle.
 */
export function handleReplyEnded(
  runtime: ReplyEndRuntime,
  reply: EndedReply
): void {
  const requester = runtime.stopRequests.removeStopRequest(
    reply.assistantMessageId
  )
  const record = runtime.jobActivity.findEndedReply(reply.assistantMessageId)
  if (record === undefined) {
    runtime.hub.removeReply(reply.assistantMessageId, null)
    return
  }
  if (record.parentConversationId === null)
    handleMainReplyEnded(runtime, reply, record)
  else handleJobReplyEnded(runtime, Object.freeze({ reply, record, requester }))
  removeIdleWakeSettings(
    runtime,
    record.parentConversationId ?? record.conversationId
  )
}

/**
 * Handles the end of a reply of a main conversation: the person's reply, or
 * that of a wake-up turn.
 *
 * @param runtime - The hub, and what a wake-up turn is started with.
 * @param reply - The reply that ended.
 * @param record - The reply as stored once its end is reported.
 * @throws As {@link handleReplyEnded} does.
 * @remarks The reply is removed from the hub with its stored final state;
 * the hub ignores a reply it does not follow, such as the person's own. A
 * reply that completed or failed then starts the wake-up turn its
 * conversation is due, as {@link startDueWakeUpTurn} decides, so the
 * reports that arrived while it streamed reach the agent. A reply that was
 * interrupted starts nothing: whoever stopped it decides what comes next.
 */
function handleMainReplyEnded(
  runtime: ReplyEndRuntime,
  reply: EndedReply,
  record: EndedReplyRecord
): void {
  const status = calculateEndedActivityStatus(record)
  runtime.hub.removeReply(reply.assistantMessageId, status)
  if (status === "completed" || status === "failed")
    startDueWakeUpTurn(runtime, record.conversationId)
}

/**
 * Handles the end of a reply of a job: stores the report its delegator
 * reads, tells the hub, and wakes the delegator when the report calls for
 * it.
 *
 * @param runtime - The job reader, the report writer, the hub, the event
 * reporter, and what a wake-up turn is started with.
 * @param ending - The reply, its stored record, and who asked it to stop.
 * @throws As {@link handleReplyEnded} does.
 * @remarks The report is stored as {@link saveEndReport} stores it. Then
 * the reply is removed from the hub with its stored final state, and the
 * job's update, read once the report is stored, is sent. A `result` or a
 * `failed` report stored here then starts the wake-up turn the delegator's
 * conversation is due, as {@link startDueWakeUpTurn} decides; no other
 * report does. A job that is no longer stored gets no report and no update.
 */
function handleJobReplyEnded(
  runtime: ReplyEndRuntime,
  ending: JobReplyEnding
): void {
  const { reply, record } = ending
  const reportKind = saveEndReport(runtime, ending)
  runtime.hub.removeReply(
    reply.assistantMessageId,
    calculateEndedActivityStatus(record)
  )
  const ended = runtime.jobs.findJob(record.conversationId)
  if (ended === undefined) return
  runtime.hub.sendJobUpdate(ended.parentConversationId, ended.job)
  if (reportKind === "result" || reportKind === "failed")
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
