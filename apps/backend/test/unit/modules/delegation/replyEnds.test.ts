import type { ActivityEvent } from "@lys/protocol"
import type { Job, JobReportKind, JobState } from "@lys/share"
import { describe, expect, it, onTestFinished, vi, type Mock } from "vitest"
import ActivityHub, {
  type ActivityReplyTarget,
  type EndedActivityStatus
} from "../../../../src/modules/activity/activityHub"
import type { AssistantMessageCompletion } from "../../../../src/modules/agent/agent"
import type { ReplyPartDraft } from "../../../../src/modules/agent/replyPartSequence"
import type { EndedReply } from "../../../../src/modules/chat/turnStart"
import type { DelegationRuntime } from "../../../../src/modules/delegation/dependencies"
import { handleReplyEnded } from "../../../../src/modules/delegation/replyEnds"
import type { StopRequester } from "../../../../src/modules/delegation/replyStopRequests"
import {
  createPersonTurn,
  DELEGATING_TURN_SETTINGS,
  FIRST_MEMBER,
  MOTHS_REQUEST,
  openDelegationTestServices,
  SECOND_MEMBER,
  sendJobMessage,
  type DelegationTestServices,
  type JobMessageRequest
} from "../../support/delegationTestServices"
import { waitForMicrotasks } from "../../support/microtasks"

/** Text the job replies of the cases write in their last round. */
const LAST_ROUND_TEXT = "Most moths drink nectar."

/** Snapshot of a hub that follows no reply. */
const EMPTY_ACTIVITY_SNAPSHOT: ActivityEvent = Object.freeze({
  type: "activity-snapshot",
  replies: []
})

/** What a stored end report is expected to say. */
type ExpectedEndReport = Readonly<{
  /** How the reply ended. */
  kind: JobReportKind
  /** Text of the report. */
  content: string
}>

/**
 * Builds the end of a reply as its turn start tells it.
 *
 * @param conversationId - UUIDv7 of the conversation that holds the reply.
 * @param assistantMessageId - UUIDv7 of the reply.
 * @param errorMessage - Sentence of the reply's `error` event; none when
 * omitted.
 * @returns The frozen ended reply.
 */
function buildEndedReply(
  conversationId: string,
  assistantMessageId: string,
  errorMessage?: string
): EndedReply {
  return Object.freeze({ conversationId, assistantMessageId, errorMessage })
}

/**
 * Remembers who asked a job's reply to stop, as a stop does before the
 * reply ends.
 *
 * @param services - The case's runtime.
 * @param replyId - UUIDv7 of the reply.
 * @param requester - Who asked; undefined when nobody did, which remembers
 * nothing.
 */
function addStopRequest(
  services: Pick<DelegationTestServices, "runtime">,
  replyId: string,
  requester: StopRequester | undefined
): void {
  if (requester === undefined) return
  services.runtime.stopRequests.addStopRequest(replyId, requester)
}

/**
 * Stores a text part of a streaming reply, as the reply's agent writes one.
 *
 * @param services - The case's conversation services.
 * @param replyId - UUIDv7 of the reply.
 * @param text - The part: the zero-based model round it belongs to and its
 * non-empty text.
 * @throws If the reply is no longer streaming.
 */
function createReplyText(
  services: Pick<DelegationTestServices, "conversation">,
  replyId: string,
  text: Extract<ReplyPartDraft, { kind: "text" }>
): void {
  const part = services.conversation.replyParts.createReplyPart(replyId, text)
  if (part === undefined) throw new Error("The reply took no text")
}

/** Records each event written to one activity stream's connection. */
type RecordedStream = Mock<(event: ActivityEvent) => Promise<void>>

/** A job's reply that a real hub follows, with the runtime that tells it. */
type FollowedJobReply = Readonly<{
  /** The case's runtime, telling the real hub instead of the recording one. */
  runtime: DelegationRuntime
  /** Hub that follows the reply; disposed of when the test finishes. */
  hub: ActivityHub
  /** The stream opened on the hub once it followed the reply. */
  stream: RecordedStream
}>

/**
 * Opens a stream on a hub whose connection accepts every write at once.
 *
 * @param hub - Hub the stream follows.
 * @returns The stream's writer, which records each written event.
 */
function openRecordedStream(hub: ActivityHub): RecordedStream {
  const sendEvent: RecordedStream = vi.fn(() => Promise.resolve())
  hub.openStream(sendEvent)
  return sendEvent
}

/**
 * Follows a job's running reply with a real hub, as the job message that
 * started it does, and opens a stream on that hub.
 *
 * @param services - The case's runtime and the turns it started.
 * @param job - The working job.
 * @param parentConversationId - UUIDv7 of the conversation the job was
 * started from.
 * @returns The case's runtime over the real hub, the hub, and its stream.
 */
function followJobReply(
  services: Pick<DelegationTestServices, "runtime" | "findStartedTurn">,
  job: Job,
  parentConversationId: string
): FollowedJobReply {
  const hub = new ActivityHub()
  onTestFinished(() => {
    hub[Symbol.dispose]()
  })
  const target: ActivityReplyTarget = Object.freeze({
    conversationId: job.id,
    parentConversationId,
    assistantMessageId: job.replyId
  })
  hub.addReply(target, services.findStartedTurn(job.replyId).generation)
  const stream = openRecordedStream(hub)
  const runtime: DelegationRuntime = Object.freeze({
    ...services.runtime,
    hub
  })
  return Object.freeze({ runtime, hub, stream })
}

describe("handleReplyEnded", () => {
  it.for<
    [
      string,
      AssistantMessageCompletion,
      StopRequester | undefined,
      EndedActivityStatus,
      JobState
    ]
  >([
    [
      "completed",
      { status: "completed", finishReason: "stop" },
      undefined,
      "completed",
      "replied"
    ],
    ["failed", { status: "failed" }, undefined, "failed", "failed"],
    [
      "was interrupted",
      { status: "interrupted" },
      undefined,
      "interrupted",
      "interrupted"
    ],
    [
      "the person stopped",
      { status: "interrupted" },
      "person",
      "interrupted",
      "stopped"
    ],
    [
      "its delegator stopped",
      { status: "interrupted" },
      "delegator",
      "interrupted",
      "stopped"
    ]
  ])(
    "removes a job's reply that %s from the hub with its stored status, and sends the job update",
    ([, completion, requester, status, jobState]) => {
      const services = openDelegationTestServices()
      const delegating = createPersonTurn(services.conversation.turns)
      const conversationId = delegating.turn.conversation.id
      const job = sendJobMessage(services, delegating, MOTHS_REQUEST)
      addStopRequest(services, job.replyId, requester)
      services.conversation.turns.updateAssistantMessageState(
        job.replyId,
        completion
      )

      handleReplyEnded(services.runtime, buildEndedReply(job.id, job.replyId))

      const endedJob = services.runtime.jobs.findJob(job.id)?.job
      expect(endedJob?.state).toBe(jobState)
      expect(services.hub.removeReply).toHaveBeenCalledExactlyOnceWith(
        job.replyId,
        status
      )
      expect(services.hub.sendJobUpdate).toHaveBeenLastCalledWith(
        conversationId,
        endedJob
      )
    }
  )

  it.for<
    [
      string,
      AssistantMessageCompletion,
      StopRequester | undefined,
      string | undefined,
      ExpectedEndReport
    ]
  >([
    [
      "the result of a completed reply",
      { status: "completed", finishReason: "stop" },
      undefined,
      undefined,
      { kind: "result", content: LAST_ROUND_TEXT }
    ],
    [
      "the cut-off result of a reply that reached the length limit",
      { status: "completed", finishReason: "length" },
      undefined,
      undefined,
      {
        kind: "result",
        content: `${LAST_ROUND_TEXT}\n\n(The reply was cut off at the model's length limit.)`
      }
    ],
    [
      "the result of a reply that completed before the stop its delegator asked for",
      { status: "completed", finishReason: "stop" },
      "delegator",
      undefined,
      { kind: "result", content: LAST_ROUND_TEXT }
    ],
    [
      "the failure sentence of a failed reply",
      { status: "failed" },
      undefined,
      "The model stopped answering.",
      { kind: "failed", content: "The model stopped answering." }
    ],
    [
      "a failure of its own for a failed reply without an error event",
      { status: "failed" },
      undefined,
      undefined,
      { kind: "failed", content: "The agent's reply failed." }
    ],
    [
      "a stop for a reply the person stopped",
      { status: "interrupted" },
      "person",
      undefined,
      { kind: "stopped", content: "" }
    ],
    [
      "an interruption for a reply nobody asked to stop",
      { status: "interrupted" },
      undefined,
      undefined,
      { kind: "interrupted", content: "" }
    ]
  ])(
    "stores %s for a job's ended reply, with the job's title",
    ([, completion, requester, errorMessage, expected]) => {
      const services = openDelegationTestServices()
      const delegating = createPersonTurn(services.conversation.turns)
      const conversationId = delegating.turn.conversation.id
      const job = sendJobMessage(services, delegating, MOTHS_REQUEST)
      createReplyText(services, job.replyId, {
        kind: "text",
        round: 0,
        content: LAST_ROUND_TEXT
      })
      addStopRequest(services, job.replyId, requester)
      services.conversation.turns.updateAssistantMessageState(
        job.replyId,
        completion
      )

      handleReplyEnded(
        services.runtime,
        buildEndedReply(job.id, job.replyId, errorMessage)
      )

      const next = createPersonTurn(services.conversation.turns, {
        kind: "existing",
        id: conversationId
      })
      expect(next.turn.userMessage.reports).toMatchObject([
        {
          jobId: job.id,
          jobNumber: 1,
          agentCode: FIRST_MEMBER,
          title: "Moths",
          kind: expected.kind,
          content: expected.content
        }
      ])
      expect(services.reportEvent).toHaveBeenCalledWith({
        kind: "report-stored",
        conversationId,
        jobId: job.id,
        jobNumber: 1,
        reportKind: expected.kind
      })
    }
  )

  it("stores no report for a job's reply its delegator stopped", () => {
    const services = openDelegationTestServices()
    const delegating = createPersonTurn(services.conversation.turns)
    const conversationId = delegating.turn.conversation.id
    const job = sendJobMessage(services, delegating, MOTHS_REQUEST)
    services.runtime.stopRequests.addStopRequest(job.replyId, "delegator")
    services.conversation.turns.updateAssistantMessageState(job.replyId, {
      status: "interrupted"
    })

    handleReplyEnded(services.runtime, buildEndedReply(job.id, job.replyId))

    const next = createPersonTurn(services.conversation.turns, {
      kind: "existing",
      id: conversationId
    })
    expect(next.turn.userMessage.reports).toEqual([])
    expect(services.reportEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "report-stored" })
    )
  })

  it("uses only the text of the reply's last round as the result", () => {
    const services = openDelegationTestServices()
    const delegating = createPersonTurn(services.conversation.turns)
    const conversationId = delegating.turn.conversation.id
    const job = sendJobMessage(services, delegating, MOTHS_REQUEST)
    createReplyText(services, job.replyId, {
      kind: "text",
      round: 0,
      content: "Let me look that up."
    })
    createReplyText(services, job.replyId, {
      kind: "text",
      round: 1,
      content: LAST_ROUND_TEXT
    })
    services.conversation.turns.updateAssistantMessageState(job.replyId, {
      status: "completed",
      finishReason: "stop"
    })

    handleReplyEnded(services.runtime, buildEndedReply(job.id, job.replyId))

    const next = createPersonTurn(services.conversation.turns, {
      kind: "existing",
      id: conversationId
    })
    expect(next.turn.userMessage.reports).toMatchObject([
      { kind: "result", content: LAST_ROUND_TEXT }
    ])
  })

  it("stores one end report per reply when its end is handled twice", () => {
    const services = openDelegationTestServices()
    const delegating = createPersonTurn(services.conversation.turns)
    const conversationId = delegating.turn.conversation.id
    const job = sendJobMessage(services, delegating, MOTHS_REQUEST)
    services.conversation.turns.updateAssistantMessageState(job.replyId, {
      status: "completed",
      finishReason: "stop"
    })
    handleReplyEnded(services.runtime, buildEndedReply(job.id, job.replyId))
    const eventCount = services.reportEvent.mock.calls.length

    handleReplyEnded(services.runtime, buildEndedReply(job.id, job.replyId))

    const next = createPersonTurn(services.conversation.turns, {
      kind: "existing",
      id: conversationId
    })
    expect(next.turn.userMessage.reports).toMatchObject([
      { jobId: job.id, kind: "result" }
    ])
    expect(services.reportEvent).toHaveBeenCalledTimes(eventCount)
  })

  it("removes a reply whose conversation was deleted from the hub with null, and sends no job update", () => {
    const services = openDelegationTestServices()
    const delegating = createPersonTurn(services.conversation.turns)
    const job = sendJobMessage(services, delegating, MOTHS_REQUEST)
    services.conversation.editor.deleteConversation(
      delegating.turn.conversation.id
    )
    const updateCount = services.hub.sendJobUpdate.mock.calls.length

    handleReplyEnded(services.runtime, buildEndedReply(job.id, job.replyId))

    expect(services.hub.removeReply).toHaveBeenCalledExactlyOnceWith(
      job.replyId,
      null
    )
    expect(services.hub.sendJobUpdate).toHaveBeenCalledTimes(updateCount)
  })

  it("stores no report and starts no turn for a completed reply whose job was deleted with its conversation", () => {
    const services = openDelegationTestServices()
    const delegating = createPersonTurn(services.conversation.turns)
    const job = sendJobMessage(services, delegating, MOTHS_REQUEST)
    services.conversation.turns.updateAssistantMessageState(job.replyId, {
      status: "completed",
      finishReason: "stop"
    })
    services.conversation.editor.deleteConversation(
      delegating.turn.conversation.id
    )
    const eventCount = services.reportEvent.mock.calls.length

    handleReplyEnded(services.runtime, buildEndedReply(job.id, job.replyId))

    expect(services.reportEvent).toHaveBeenCalledTimes(eventCount)
    expect(services.listStartedTurns()).toHaveLength(1)
  })

  it("removes a reply still stored as streaming from the hub as interrupted", () => {
    const services = openDelegationTestServices()
    const delegating = createPersonTurn(services.conversation.turns)
    const job = sendJobMessage(services, delegating, MOTHS_REQUEST)

    handleReplyEnded(services.runtime, buildEndedReply(job.id, job.replyId))

    expect(services.hub.removeReply).toHaveBeenCalledExactlyOnceWith(
      job.replyId,
      "interrupted"
    )
  })

  it("forgets who asked the reply to stop", () => {
    const services = openDelegationTestServices()
    const delegating = createPersonTurn(services.conversation.turns)
    const job = sendJobMessage(services, delegating, MOTHS_REQUEST)
    services.runtime.stopRequests.addStopRequest(job.replyId, "delegator")
    services.conversation.turns.updateAssistantMessageState(job.replyId, {
      status: "interrupted"
    })

    handleReplyEnded(services.runtime, buildEndedReply(job.id, job.replyId))

    expect(
      services.runtime.stopRequests.removeStopRequest(job.replyId)
    ).toBeUndefined()
  })

  it("removes a person's reply from the hub without a job update", () => {
    const services = openDelegationTestServices()
    const personTurn = createPersonTurn(services.conversation.turns)
    const { conversation, assistantMessage } = personTurn.turn
    services.conversation.turns.updateAssistantMessageState(
      assistantMessage.id,
      { status: "completed", finishReason: "stop" }
    )

    handleReplyEnded(
      services.runtime,
      buildEndedReply(conversation.id, assistantMessage.id)
    )

    expect(services.hub.removeReply).toHaveBeenCalledExactlyOnceWith(
      assistantMessage.id,
      "completed"
    )
    expect(services.hub.sendJobUpdate).not.toHaveBeenCalled()
  })

  it("drops the delegator's wake settings once its last working job ended with no report that wakes it", () => {
    const services = openDelegationTestServices()
    const delegating = createPersonTurn(services.conversation.turns)
    const conversationId = delegating.turn.conversation.id
    const job = sendJobMessage(services, delegating, MOTHS_REQUEST)
    services.runtime.stopRequests.addStopRequest(job.replyId, "delegator")
    services.conversation.turns.updateAssistantMessageState(job.replyId, {
      status: "interrupted"
    })

    handleReplyEnded(services.runtime, buildEndedReply(job.id, job.replyId))

    expect(
      services.runtime.wakeSettings.findWakeSettings(conversationId)
    ).toEqual({ status: "none" })
  })

  it("keeps the delegator's wake settings while another of its jobs works", () => {
    /** Work a case gives {@link SECOND_MEMBER} beside the moths job. */
    const archiveRequest: JobMessageRequest = Object.freeze({
      agentCode: SECOND_MEMBER,
      title: "Archive",
      instructions: "File what is known about moths",
      jobNumber: undefined
    })

    const services = openDelegationTestServices()
    const delegating = createPersonTurn(services.conversation.turns)
    const conversationId = delegating.turn.conversation.id
    const job = sendJobMessage(services, delegating, MOTHS_REQUEST)
    sendJobMessage(services, delegating, archiveRequest)
    services.runtime.stopRequests.addStopRequest(job.replyId, "delegator")
    services.conversation.turns.updateAssistantMessageState(job.replyId, {
      status: "interrupted"
    })

    handleReplyEnded(services.runtime, buildEndedReply(job.id, job.replyId))

    expect(
      services.runtime.wakeSettings.findWakeSettings(conversationId)
    ).toEqual({ status: "found", settings: DELEGATING_TURN_SETTINGS })
  })

  it("keeps the delegator's wake settings while a result of its job waits for the delegator's streaming reply to end", () => {
    const services = openDelegationTestServices()
    const delegating = createPersonTurn(services.conversation.turns)
    const conversationId = delegating.turn.conversation.id
    const job = sendJobMessage(services, delegating, MOTHS_REQUEST)
    services.conversation.turns.updateAssistantMessageState(job.replyId, {
      status: "completed",
      finishReason: "stop"
    })

    handleReplyEnded(services.runtime, buildEndedReply(job.id, job.replyId))

    expect(
      services.runtime.wakeSettings.findWakeSettings(conversationId)
    ).toEqual({ status: "found", settings: DELEGATING_TURN_SETTINGS })
    expect(services.reportEvent).toHaveBeenLastCalledWith({
      kind: "wake-up-skipped",
      conversationId,
      reason: "reply-streaming"
    })
  })

  it("ends a job's reply in the hub with null, and throws, when the reply cannot be read", async () => {
    const services = openDelegationTestServices()
    const delegating = createPersonTurn(services.conversation.turns)
    const conversationId = delegating.turn.conversation.id
    const job = sendJobMessage(services, delegating, MOTHS_REQUEST)
    const followed = followJobReply(services, job, conversationId)
    const readFailure = new Error("The database file is locked")
    vi.spyOn(
      services.runtime.jobActivity,
      "findEndedReply"
    ).mockImplementationOnce(() => {
      throw readFailure
    })

    expect(() =>
      handleReplyEnded(followed.runtime, buildEndedReply(job.id, job.replyId))
    ).toThrow(readFailure)

    const laterStream = openRecordedStream(followed.hub)
    await waitForMicrotasks()
    expect(followed.stream).toHaveBeenLastCalledWith({
      type: "reply-ended",
      conversationId: job.id,
      parentConversationId: conversationId,
      assistantMessageId: job.replyId,
      status: null
    })
    expect(laterStream).toHaveBeenCalledExactlyOnceWith(EMPTY_ACTIVITY_SNAPSHOT)
  })

  it("ends a job's reply in the hub with its stored status, sends no job update, and throws, when its end report cannot be stored", async () => {
    const services = openDelegationTestServices()
    const delegating = createPersonTurn(services.conversation.turns)
    const conversationId = delegating.turn.conversation.id
    const job = sendJobMessage(services, delegating, MOTHS_REQUEST)
    const followed = followJobReply(services, job, conversationId)
    services.conversation.turns.updateAssistantMessageState(job.replyId, {
      status: "completed",
      finishReason: "stop"
    })
    const writeFailure = new Error("The disk is full")
    vi.spyOn(
      services.runtime.reports,
      "createEndReport"
    ).mockImplementationOnce(() => {
      throw writeFailure
    })

    expect(() =>
      handleReplyEnded(followed.runtime, buildEndedReply(job.id, job.replyId))
    ).toThrow(writeFailure)

    const laterStream = openRecordedStream(followed.hub)
    await waitForMicrotasks()
    expect(followed.stream).toHaveBeenLastCalledWith({
      type: "reply-ended",
      conversationId: job.id,
      parentConversationId: conversationId,
      assistantMessageId: job.replyId,
      status: "completed"
    })
    expect(followed.stream).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "job-updated" })
    )
    expect(laterStream).toHaveBeenCalledExactlyOnceWith(EMPTY_ACTIVITY_SNAPSHOT)
  })
})
