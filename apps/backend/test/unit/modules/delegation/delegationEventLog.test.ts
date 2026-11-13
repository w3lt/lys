import { describe, expect, it } from "vitest"
import { createBackendLogger } from "../../../../src/log"
import type { DelegationEvent } from "../../../../src/modules/delegation/delegationEvent"
import { handleDelegationEvent } from "../../../../src/modules/delegation/delegationEventLog"
import { createFixtureUuidV7 } from "../../support/conversationFixtures"
import { CapturedLogDestination } from "../../support/fastifyTestApp"

/** Identity of the main conversation every event is about. */
const CONVERSATION_ID = createFixtureUuidV7(1)

/** Identity of a job of that conversation. */
const JOB_ID = createFixtureUuidV7(2)

/** Identity of a wake-up reply of that conversation. */
const WAKE_UP_REPLY_ID = createFixtureUuidV7(3)

/** Names of the fields every backend log line has, whatever was logged. */
const COMMON_FIELD_NAMES: ReadonlySet<string> = new Set([
  "time",
  "pid",
  "hostname"
])

/**
 * Gets the fields of the one line the backend's logger writes for an event.
 *
 * @param event - Event to log.
 * @returns The line's fields, without the time and process fields every
 * line has.
 * @throws When the logger wrote no line or more than one.
 */
function getLoggedFields(event: DelegationEvent): Record<string, unknown> {
  const destination = new CapturedLogDestination()
  handleDelegationEvent(createBackendLogger(destination), event)
  const records = destination.records
  const [record] = records
  if (record === undefined || records.length !== 1)
    throw new Error(`Expected one log line, got ${records.length}`)
  return Object.fromEntries(
    Object.entries(record).filter(([name]) => !COMMON_FIELD_NAMES.has(name))
  )
}

describe("handleDelegationEvent", () => {
  it("logs a sent job message with its job, its agent, and whether the job is new", () => {
    expect(
      getLoggedFields({
        kind: "job-message-sent",
        conversationId: CONVERSATION_ID,
        jobId: JOB_ID,
        jobNumber: 2,
        agentCode: "researcher",
        isNewJob: true
      })
    ).toEqual({
      level: "info",
      conversationId: CONVERSATION_ID,
      jobId: JOB_ID,
      jobNumber: 2,
      agentCode: "researcher",
      isNewJob: true,
      msg: "An agent gave work to another agent"
    })
  })

  it("warns of a refused job message with its agent, its job number, and the reason", () => {
    expect(
      getLoggedFields({
        kind: "job-message-refused",
        conversationId: CONVERSATION_ID,
        agentCode: "researcher",
        jobNumber: 2,
        reason: "job-is-working"
      })
    ).toEqual({
      level: "warn",
      conversationId: CONVERSATION_ID,
      agentCode: "researcher",
      jobNumber: 2,
      reason: "job-is-working",
      msg: "A job message was refused"
    })
  })

  it("warns of a refused message for a new job with a null job number", () => {
    expect(
      getLoggedFields({
        kind: "job-message-refused",
        conversationId: CONVERSATION_ID,
        agentCode: "nobody",
        jobNumber: undefined,
        reason: "agent-not-found"
      })
    ).toEqual({
      level: "warn",
      conversationId: CONVERSATION_ID,
      agentCode: "nobody",
      jobNumber: null,
      reason: "agent-not-found",
      msg: "A job message was refused"
    })
  })

  it("logs a stored report with its job and its kind", () => {
    expect(
      getLoggedFields({
        kind: "report-stored",
        conversationId: CONVERSATION_ID,
        jobId: JOB_ID,
        jobNumber: 2,
        reportKind: "result"
      })
    ).toEqual({
      level: "info",
      conversationId: CONVERSATION_ID,
      jobId: JOB_ID,
      jobNumber: 2,
      reportKind: "result",
      msg: "A job report was stored"
    })
  })

  it("logs a started wake-up turn with its reply and the number of reports", () => {
    expect(
      getLoggedFields({
        kind: "wake-up-started",
        conversationId: CONVERSATION_ID,
        assistantMessageId: WAKE_UP_REPLY_ID,
        reportCount: 3
      })
    ).toEqual({
      level: "info",
      conversationId: CONVERSATION_ID,
      assistantMessageId: WAKE_UP_REPLY_ID,
      reportCount: 3,
      msg: "A wake-up turn started"
    })
  })

  it("logs a wake-up turn that did not start with the reason", () => {
    expect(
      getLoggedFields({
        kind: "wake-up-skipped",
        conversationId: CONVERSATION_ID,
        reason: "no-wake-settings"
      })
    ).toEqual({
      level: "info",
      conversationId: CONVERSATION_ID,
      reason: "no-wake-settings",
      msg: "A wake-up turn did not start"
    })
  })

  it("logs a stop request with its requester and the number of replies it stopped", () => {
    expect(
      getLoggedFields({
        kind: "stop-requested",
        conversationId: CONVERSATION_ID,
        requester: "person",
        stoppedReplyCount: 2
      })
    ).toEqual({
      level: "info",
      conversationId: CONVERSATION_ID,
      requester: "person",
      stoppedReplyCount: 2,
      msg: "Jobs were asked to stop"
    })
  })
})
