import type { FastifyBaseLogger } from "fastify"
import type { DelegationEvent } from "./delegationEvent"

/** An event about one job message. */
type JobMessageEvent = Extract<
  DelegationEvent,
  { kind: "job-message-sent" | "job-message-refused" }
>

/** An event about one wake-up turn. */
type WakeUpEvent = Extract<
  DelegationEvent,
  { kind: "wake-up-started" | "wake-up-skipped" }
>

/**
 * Writes one delegation event to the backend log.
 *
 * @param logger - Backend logger, borrowed for the call.
 * @param event - Event delegation reported.
 * @throws {TypeError} If the event is of a kind this module does not know.
 * @remarks A refused job message is a warning; every other event is
 * information. An entry holds the event's fields without `kind`, which its
 * message tells: identities, numbers, codes, kinds, reasons, and counts. No
 * entry holds the title or the instructions of a job message, a progress
 * note, or the text of a report. The `jobNumber` of a refused message's
 * entry is null when the call asked for a new job.
 */
export function handleDelegationEvent(
  logger: FastifyBaseLogger,
  event: DelegationEvent
): void {
  switch (event.kind) {
    case "job-message-sent":
    case "job-message-refused":
      handleJobMessageEvent(logger, event)
      return
    case "report-stored":
      logger.info(
        {
          conversationId: event.conversationId,
          jobId: event.jobId,
          jobNumber: event.jobNumber,
          reportKind: event.reportKind
        },
        "A job report was stored"
      )
      return
    case "wake-up-started":
    case "wake-up-skipped":
      handleWakeUpEvent(logger, event)
      return
    case "stop-requested":
      logger.info(
        {
          conversationId: event.conversationId,
          requester: event.requester,
          stoppedReplyCount: event.stoppedReplyCount
        },
        "Jobs were asked to stop"
      )
      return
    default: {
      const unhandledEvent: never = event
      throw new TypeError(
        `Unhandled delegation event: ${JSON.stringify(unhandledEvent)}`
      )
    }
  }
}

/**
 * Writes one event about a job message: a sent one as information, a
 * refused one as a warning.
 *
 * @param logger - Backend logger.
 * @param event - Job message event.
 * @throws {TypeError} If the event is of a kind this module does not know.
 */
function handleJobMessageEvent(
  logger: FastifyBaseLogger,
  event: JobMessageEvent
): void {
  switch (event.kind) {
    case "job-message-sent":
      logger.info(
        {
          conversationId: event.conversationId,
          jobId: event.jobId,
          jobNumber: event.jobNumber,
          agentCode: event.agentCode,
          isNewJob: event.isNewJob
        },
        "An agent gave work to another agent"
      )
      return
    case "job-message-refused":
      logger.warn(
        {
          conversationId: event.conversationId,
          agentCode: event.agentCode,
          jobNumber: event.jobNumber ?? null,
          reason: event.reason
        },
        "A job message was refused"
      )
      return
    default: {
      const unhandledEvent: never = event
      throw new TypeError(
        `Unhandled job message event: ${JSON.stringify(unhandledEvent)}`
      )
    }
  }
}

/**
 * Writes one event about a wake-up turn, as information.
 *
 * @param logger - Backend logger.
 * @param event - Wake-up event.
 * @throws {TypeError} If the event is of a kind this module does not know.
 */
function handleWakeUpEvent(
  logger: FastifyBaseLogger,
  event: WakeUpEvent
): void {
  switch (event.kind) {
    case "wake-up-started":
      logger.info(
        {
          conversationId: event.conversationId,
          assistantMessageId: event.assistantMessageId,
          reportCount: event.reportCount
        },
        "A wake-up turn started"
      )
      return
    case "wake-up-skipped":
      logger.info(
        { conversationId: event.conversationId, reason: event.reason },
        "A wake-up turn did not start"
      )
      return
    default: {
      const unhandledEvent: never = event
      throw new TypeError(
        `Unhandled wake-up event: ${JSON.stringify(unhandledEvent)}`
      )
    }
  }
}
