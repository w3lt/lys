import type { JobReportKind } from "@lys/share"
import type { JobMessageRefusal } from "../agent/turnDelegation"
import type { StopRequester } from "./replyStopRequests"

/**
 * Something delegation did, or did not do, that no caller observes, reported
 * for the log.
 *
 * @remarks `kind` selects the variant. Each event tells something that has
 * already happened, and is reported once. An event carries identities,
 * numbers, codes, kinds, reasons, and counts only: never the title or the
 * instructions of a job message, a progress note, or the text of a report.
 */
export type DelegationEvent =
  | Readonly<{
      /** A job message was stored, and the job's reply started. */
      kind: "job-message-sent"
      /**
       * UUIDv7 of the delegator's conversation, which the message was sent
       * from.
       */
      conversationId: string
      /** UUIDv7 of the job: its conversation. */
      jobId: string
      /** The job's number in the delegator's conversation, from 1. */
      jobNumber: number
      /** Code of the agent that does the work. */
      agentCode: string
      /** Whether the message started the job; false when it continued one. */
      isNewJob: boolean
    }>
  | Readonly<{
      /** A job message was not sent: nothing was stored or started. */
      kind: "job-message-refused"
      /**
       * UUIDv7 of the delegator's conversation, which the message was to be
       * sent from.
       */
      conversationId: string
      /** Valid agent code the `delegate_work` call named. */
      agentCode: string
      /**
       * Number of the job the call asked to continue; undefined when it
       * asked for a new job.
       */
      jobNumber: number | undefined
      /** Why the message was refused. */
      reason: JobMessageRefusal["kind"]
    }>
  | Readonly<{
      /** A report a job sent to its delegator was stored. */
      kind: "report-stored"
      /**
       * UUIDv7 of the delegator's conversation, which the job was started
       * from.
       */
      conversationId: string
      /** UUIDv7 of the job: its conversation. */
      jobId: string
      /** The job's number in the delegator's conversation, from 1. */
      jobNumber: number
      /** What the report says. */
      reportKind: JobReportKind
    }>
  | Readonly<{
      /** A wake-up turn started in a conversation whose jobs sent reports. */
      kind: "wake-up-started"
      /** UUIDv7 of the conversation. */
      conversationId: string
      /** UUIDv7 of the turn's reply. */
      assistantMessageId: string
      /** Number of reports the turn delivered to the conversation. */
      reportCount: number
    }>
  | Readonly<{
      /**
       * A report that wakes the delegator waits in a conversation, and no
       * wake-up turn started for it.
       */
      kind: "wake-up-skipped"
      /** UUIDv7 of the conversation. */
      conversationId: string
      /**
       * Why: a reply of the conversation is still streaming; no wake
       * settings are remembered for the conversation; the backend is
       * shutting down; or the conversation's agent cannot be loaded.
       */
      reason:
        | "reply-streaming"
        | "no-wake-settings"
        | "shutting-down"
        | "agent-missing"
    }>
  | Readonly<{
      /**
       * Replies of a conversation, or of the jobs below it, were asked to
       * stop.
       */
      kind: "stop-requested"
      /** UUIDv7 of that conversation. */
      conversationId: string
      /** Who asked. */
      requester: StopRequester
      /** Number of replies the request stopped; a non-negative integer. */
      stoppedReplyCount: number
    }>
