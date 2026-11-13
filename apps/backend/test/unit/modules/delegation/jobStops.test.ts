import type {
  ConversationAssistantMessageStatus,
  Job,
  JobState
} from "@lys/share"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import type { ReplyTarget } from "../../../../src/modules/chat/replyGenerationRegistry"
import type { TurnDelegationContext } from "../../../../src/modules/chat/turnStart"
import type { DelegationEvent } from "../../../../src/modules/delegation/delegationEvent"
import {
  stopConversationJobs,
  stopJob,
  stopReplyForPerson
} from "../../../../src/modules/delegation/jobStops"
import ControlledReplyTask from "../../support/controlledReplyTask"
import {
  createPersonTurn,
  MOTHS_REQUEST,
  openDelegationTestServices,
  SECOND_MEMBER,
  sendJobMessage,
  startPersonTurn,
  type DelegationTestServices,
  type JobMessageRequest
} from "../../support/delegationTestServices"
import { waitForMicrotasks } from "../../support/microtasks"

/** Cancellation of a wait that a case never cancels. */
const NEVER_ABORTED_SIGNAL = new AbortController().signal

/** Work a case gives {@link SECOND_MEMBER} beside the moths job. */
const ARCHIVE_REQUEST: JobMessageRequest = Object.freeze({
  agentCode: SECOND_MEMBER,
  title: "Archive",
  instructions: "File what is known about moths",
  jobNumber: undefined
})

/**
 * Builds the address of a turn's reply, as the person's stop names it.
 *
 * @param context - The stored turn.
 * @returns The frozen address of the turn's reply in its conversation.
 */
function buildReplyTarget(context: TurnDelegationContext): ReplyTarget {
  return Object.freeze({
    conversationId: context.turn.conversation.id,
    assistantMessageId: context.turn.assistantMessage.id
  })
}

/**
 * Reads the stored state of a turn's reply.
 *
 * @param services - The case's runtime.
 * @param context - The started turn.
 * @returns The reply's state; undefined when the reply is not stored.
 */
function findReplyStatus(
  services: Pick<DelegationTestServices, "runtime">,
  context: TurnDelegationContext
): ConversationAssistantMessageStatus | undefined {
  return services.runtime.jobActivity.findEndedReply(
    context.turn.assistantMessage.id
  )?.status
}

/**
 * Lists the states of a conversation's jobs.
 *
 * @param services - The case's runtime.
 * @param conversationId - UUIDv7 of the conversation.
 * @returns The state of each job, in number order.
 */
function listJobStates(
  services: Pick<DelegationTestServices, "runtime">,
  conversationId: string
): readonly JobState[] {
  return services.runtime.jobs.listJobs(conversationId).map((job) => job.state)
}

/**
 * Lists the `stop-requested` events a case's runtime reported.
 *
 * @param services - The case's event recorder.
 * @returns The events, in the order they were reported.
 */
function listStopEvents(
  services: Pick<DelegationTestServices, "reportEvent">
): readonly DelegationEvent[] {
  return services.reportEvent.mock.calls
    .map(([event]) => event)
    .filter((event) => event.kind === "stop-requested")
}

/**
 * Ends a working job, in a way of its own, before a case asks to stop it.
 *
 * @param services - The case's runtime and controls.
 * @param job - The working job, as stored when it was sent.
 * @param conversationId - UUIDv7 of the conversation the job belongs to.
 * @returns A promise that resolves once the job's reply ended and its end
 * was handled.
 */
type JobEnding = (
  services: DelegationTestServices,
  job: Job,
  conversationId: string
) => Promise<void>

/**
 * Ends a job's reply as completed, so the job replied.
 *
 * @param services - The case's controls.
 * @param job - The working job.
 * @returns A promise that resolves once the reply's end was handled.
 */
async function replyToJob(
  services: DelegationTestServices,
  job: Job
): Promise<void> {
  await services.resolveReply(job.replyId, "completed")
}

/**
 * Ends a job's reply as failed, with the sentence of its `error` event.
 *
 * @param services - The case's controls.
 * @param job - The working job.
 * @returns A promise that resolves once the reply's end was handled.
 */
async function failJob(
  services: DelegationTestServices,
  job: Job
): Promise<void> {
  await services.resolveReply(
    job.replyId,
    "failed",
    "The model stopped answering"
  )
}

/**
 * Stops a job as its delegator does, so it reads as stopped.
 *
 * @param services - The case's runtime.
 * @param job - The working job.
 * @param conversationId - UUIDv7 of the conversation the job belongs to.
 * @returns A promise that resolves once the stop answered.
 */
async function stopJobFirst(
  services: DelegationTestServices,
  job: Job,
  conversationId: string
): Promise<void> {
  await stopJob(services.runtime, {
    conversationId,
    jobNumber: job.number,
    abortSignal: NEVER_ABORTED_SIGNAL
  })
}

/**
 * Ends a job's reply as interrupted without anyone asking it to stop, as
 * the backend's shutdown cuts a reply off; its end stores an interrupted
 * report.
 *
 * @param services - The case's controls.
 * @param job - The working job.
 * @returns A promise that resolves once the reply's end was handled.
 */
async function interruptJob(
  services: DelegationTestServices,
  job: Job
): Promise<void> {
  await services.resolveReply(job.replyId, "interrupted")
}

describe("stopJob", () => {
  it("stops a working job's reply, waits for its final state, and answers stopped", async () => {
    const services = openDelegationTestServices()
    const delegating = createPersonTurn(services.conversation.turns)
    const conversationId = delegating.turn.conversation.id
    const job = sendJobMessage(services, delegating, MOTHS_REQUEST)
    const addStopRequest = vi.spyOn(
      services.runtime.stopRequests,
      "addStopRequest"
    )

    const outcome = await stopJob(services.runtime, {
      conversationId,
      jobNumber: 1,
      abortSignal: NEVER_ABORTED_SIGNAL
    })

    const stoppedJob = services.runtime.jobs.findJobByNumber(conversationId, 1)
    expect(outcome).toEqual({ status: "stopped", jobNumber: 1 })
    expect(stoppedJob?.state).toBe("stopped")
    expect(
      services.conversation.history.getConversation(job.id)?.messages
    ).toMatchObject([
      { role: "user" },
      { id: job.replyId, status: "interrupted" }
    ])
    expect(addStopRequest).toHaveBeenCalledExactlyOnceWith(
      job.replyId,
      "delegator"
    )
    expect(
      services.runtime.stopRequests.removeStopRequest(job.replyId)
    ).toBeUndefined()
    expect(services.hub.removeReply).toHaveBeenCalledExactlyOnceWith(
      job.replyId,
      "interrupted"
    )
    expect(services.reportEvent).toHaveBeenLastCalledWith({
      kind: "stop-requested",
      conversationId: job.id,
      requester: "delegator",
      stoppedReplyCount: 1
    })
  })

  it.each<[string, JobEnding, Exclude<JobState, "working">]>([
    ["replied", replyToJob, "replied"],
    ["failed", failJob, "failed"],
    ["was stopped", stopJobFirst, "stopped"],
    ["was interrupted", interruptJob, "interrupted"]
  ])(
    "answers already-ended with the state for a job that %s",
    async (_label, endJob, state) => {
      const services = openDelegationTestServices()
      const delegating = createPersonTurn(services.conversation.turns)
      const conversationId = delegating.turn.conversation.id
      const job = sendJobMessage(services, delegating, MOTHS_REQUEST)
      await endJob(services, job, conversationId)
      const eventCount = services.reportEvent.mock.calls.length

      const outcome = await stopJob(services.runtime, {
        conversationId,
        jobNumber: 1,
        abortSignal: NEVER_ABORTED_SIGNAL
      })

      expect(outcome).toEqual({ status: "already-ended", jobNumber: 1, state })
      expect(services.reportEvent).toHaveBeenCalledTimes(eventCount)
    }
  )

  it("answers already-ended when the job completed by itself before the stop took effect", async () => {
    const services = openDelegationTestServices()
    const delegating = createPersonTurn(services.conversation.turns)
    const conversationId = delegating.turn.conversation.id
    const job = sendJobMessage(services, delegating, MOTHS_REQUEST)
    // The job's reply task now waits for its ending, so the ending given
    // next comes before the stop.
    await waitForMicrotasks()
    const replied = services.resolveReply(job.replyId, "completed")

    const outcome = await stopJob(services.runtime, {
      conversationId,
      jobNumber: 1,
      abortSignal: NEVER_ABORTED_SIGNAL
    })
    await replied

    expect(outcome).toEqual({
      status: "already-ended",
      jobNumber: 1,
      state: "replied"
    })
    expect(services.hub.removeReply).toHaveBeenCalledExactlyOnceWith(
      job.replyId,
      "completed"
    )
    expect(services.reportEvent).toHaveBeenCalledWith({
      kind: "stop-requested",
      conversationId: job.id,
      requester: "delegator",
      stoppedReplyCount: 1
    })
  })

  it("answers job-not-found for an unknown number", async () => {
    const services = openDelegationTestServices()
    const delegating = createPersonTurn(services.conversation.turns)
    const conversationId = delegating.turn.conversation.id
    sendJobMessage(services, delegating, MOTHS_REQUEST)
    const eventCount = services.reportEvent.mock.calls.length

    const outcome = await stopJob(services.runtime, {
      conversationId,
      jobNumber: 9,
      abortSignal: NEVER_ABORTED_SIGNAL
    })

    expect(outcome).toEqual({ status: "job-not-found", jobNumber: 9 })
    expect(
      services.runtime.jobs.findJobByNumber(conversationId, 1)?.state
    ).toBe("working")
    expect(services.reportEvent).toHaveBeenCalledTimes(eventCount)
  })

  it("rejects when the abort signal aborts before the job's reply has ended", async () => {
    const services = openDelegationTestServices()
    const delegating = createPersonTurn(services.conversation.turns)
    const conversationId = delegating.turn.conversation.id
    const job = sendJobMessage(services, delegating, MOTHS_REQUEST)
    const cancellation = new AbortController()
    const reason = new Error("The delegator's reply was stopped")

    const stopping = stopJob(services.runtime, {
      conversationId,
      jobNumber: 1,
      abortSignal: cancellation.signal
    })
    cancellation.abort(reason)

    await expect(stopping).rejects.toBe(reason)
    await services.findStartedTurn(job.replyId).generation.settled
    expect(
      services.runtime.jobs.findJobByNumber(conversationId, 1)?.state
    ).toBe("stopped")
  })
})

describe("the person's stops", () => {
  it("stops the lead's reply and every working job below it, and resolves after each reached its final state", async () => {
    const services = openDelegationTestServices()
    const lead = startPersonTurn(services)
    const conversationId = lead.turn.conversation.id
    const firstJob = sendJobMessage(services, lead, MOTHS_REQUEST)
    const secondJob = sendJobMessage(services, lead, ARCHIVE_REQUEST)

    const outcome = await stopReplyForPerson(
      services.runtime,
      buildReplyTarget(lead)
    )

    const stoppedReplyIds = [
      lead.turn.assistantMessage.id,
      firstJob.replyId,
      secondJob.replyId
    ]
    expect(outcome).toBe("stopped")
    expect(findReplyStatus(services, lead)).toBe("interrupted")
    expect(listJobStates(services, conversationId)).toEqual([
      "stopped",
      "stopped"
    ])
    expect(services.hub.removeReply).toHaveBeenCalledTimes(3)
    expect(services.hub.removeReply.mock.calls).toEqual(
      expect.arrayContaining(
        stoppedReplyIds.map((replyId) => [replyId, "interrupted"])
      )
    )
    expect(
      stoppedReplyIds.map((replyId) =>
        services.runtime.stopRequests.removeStopRequest(replyId)
      )
    ).toEqual([undefined, undefined, undefined])
  })

  it("stores a stopped report for each job the person stopped, wakes nobody, and reports one stop-requested with the count", async () => {
    const services = openDelegationTestServices()
    const lead = startPersonTurn(services)
    const conversationId = lead.turn.conversation.id
    const firstJob = sendJobMessage(services, lead, MOTHS_REQUEST)
    const secondJob = sendJobMessage(services, lead, ARCHIVE_REQUEST)

    await stopReplyForPerson(services.runtime, buildReplyTarget(lead))

    const next = createPersonTurn(services.conversation.turns, {
      kind: "existing",
      id: conversationId
    })
    expect(next.turn.userMessage.reports).toHaveLength(2)
    expect(next.turn.userMessage.reports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          jobId: firstJob.id,
          kind: "stopped",
          content: ""
        }),
        expect.objectContaining({
          jobId: secondJob.id,
          kind: "stopped",
          content: ""
        })
      ])
    )
    expect(services.listStartedTurns()).toHaveLength(3)
    expect(services.reportEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "wake-up-started" })
    )
    expect(listStopEvents(services)).toEqual([
      {
        kind: "stop-requested",
        conversationId,
        requester: "person",
        stoppedReplyCount: 3
      }
    ])
  })

  it("stores no report for a job the delegator had already asked to stop", async () => {
    const services = openDelegationTestServices()
    const lead = startPersonTurn(services)
    const conversationId = lead.turn.conversation.id
    const job = sendJobMessage(services, lead, MOTHS_REQUEST)
    const addStopRequest = vi.spyOn(
      services.runtime.stopRequests,
      "addStopRequest"
    )
    const delegatorStop = stopJob(services.runtime, {
      conversationId,
      jobNumber: job.number,
      abortSignal: NEVER_ABORTED_SIGNAL
    })

    await stopReplyForPerson(services.runtime, buildReplyTarget(lead))

    expect(await delegatorStop).toEqual({ status: "stopped", jobNumber: 1 })
    expect(addStopRequest).toHaveBeenCalledWith(job.replyId, "person")
    expect(listJobStates(services, conversationId)).toEqual(["stopped"])
    const next = createPersonTurn(services.conversation.turns, {
      kind: "existing",
      id: conversationId
    })
    expect(next.turn.userMessage.reports).toEqual([])
    expect(services.reportEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "report-stored" })
    )
  })

  it("stops the jobs below when the lead's reply already ended while its turn's title task runs, and resolves once each job reached its final state", async () => {
    const services = openDelegationTestServices()
    const lead = createPersonTurn(services.conversation.turns)
    const conversationId = lead.turn.conversation.id
    const target = buildReplyTarget(lead)
    const replyTask = new ControlledReplyTask()
    const titleTask = new ControlledReplyTask()
    services.generations.startReplyGeneration(target, {
      startReplyTask: (context) => replyTask.start(context),
      startTitleTask: (context) => titleTask.start(context),
      reportTaskFailure: vi.fn()
    })
    onTestFinished(() => {
      titleTask.resolve()
    })
    sendJobMessage(services, lead, MOTHS_REQUEST)
    sendJobMessage(services, lead, ARCHIVE_REQUEST)
    // The lead's reply completes as a reply task does, storing its final
    // state before it settles, while its turn's title task keeps running.
    services.conversation.turns.updateAssistantMessageState(
      target.assistantMessageId,
      { status: "completed", finishReason: "stop" }
    )
    replyTask.resolve()
    await waitForMicrotasks()

    const outcome = await stopReplyForPerson(services.runtime, target)

    expect(outcome).toBe("stopped")
    expect(listJobStates(services, conversationId)).toEqual([
      "stopped",
      "stopped"
    ])
    expect(titleTask.context.abortSignal.aborted).toBe(false)
    expect(listStopEvents(services)).toEqual([
      {
        kind: "stop-requested",
        conversationId,
        requester: "person",
        stoppedReplyCount: 2
      }
    ])
  })

  it("answers not-generating and stops no job when the addressed reply is not generating", async () => {
    const services = openDelegationTestServices()
    const lead = startPersonTurn(services)
    const conversationId = lead.turn.conversation.id
    sendJobMessage(services, lead, MOTHS_REQUEST)
    await services.resolveReply(lead.turn.assistantMessage.id, "completed")
    const eventCount = services.reportEvent.mock.calls.length

    const outcome = await stopReplyForPerson(
      services.runtime,
      buildReplyTarget(lead)
    )
    await waitForMicrotasks()

    expect(outcome).toBe("not-generating")
    expect(listJobStates(services, conversationId)).toEqual(["working"])
    expect(services.reportEvent).toHaveBeenCalledTimes(eventCount)
  })

  it("stops a job's own reply when the person stops it in the job view, with a stopped report", async () => {
    const services = openDelegationTestServices()
    const lead = startPersonTurn(services)
    const conversationId = lead.turn.conversation.id
    const job = sendJobMessage(services, lead, MOTHS_REQUEST)

    const outcome = await stopReplyForPerson(services.runtime, {
      conversationId: job.id,
      assistantMessageId: job.replyId
    })

    expect(outcome).toBe("stopped")
    expect(listJobStates(services, conversationId)).toEqual(["stopped"])
    expect(findReplyStatus(services, lead)).toBe("streaming")
    expect(services.reportEvent).toHaveBeenCalledWith({
      kind: "report-stored",
      conversationId,
      jobId: job.id,
      jobNumber: 1,
      reportKind: "stopped"
    })
    expect(listStopEvents(services)).toEqual([
      {
        kind: "stop-requested",
        conversationId: job.id,
        requester: "person",
        stoppedReplyCount: 1
      }
    ])
  })

  it("stops every working job of a conversation and leaves its finished jobs and its own reply alone", async () => {
    const services = openDelegationTestServices()
    const lead = startPersonTurn(services)
    const conversationId = lead.turn.conversation.id
    const finishedJob = sendJobMessage(services, lead, MOTHS_REQUEST)
    await services.resolveReply(finishedJob.replyId, "completed")
    const workingJob = sendJobMessage(services, lead, ARCHIVE_REQUEST)

    await stopConversationJobs(services.runtime, conversationId)

    expect(listJobStates(services, conversationId)).toEqual([
      "replied",
      "stopped"
    ])
    expect(findReplyStatus(services, lead)).toBe("streaming")
    expect(
      services.hub.removeReply.mock.calls.map(([replyId]) => replyId)
    ).toEqual([finishedJob.replyId, workingJob.replyId])
    expect(listStopEvents(services)).toEqual([
      {
        kind: "stop-requested",
        conversationId,
        requester: "person",
        stoppedReplyCount: 1
      }
    ])
  })

  it("starts no wake-up for a job's result that lands as the person stops every job, and delivers it with the person's next message", async () => {
    const services = openDelegationTestServices()
    const lead = startPersonTurn(services)
    const conversationId = lead.turn.conversation.id
    const job = sendJobMessage(services, lead, MOTHS_REQUEST)
    await services.resolveReply(lead.turn.assistantMessage.id, "completed")
    // The member's model has already answered when the stop reaches its
    // reply, so the reply completes by itself.
    const jobReplyEnded = services.resolveReply(job.replyId, "completed")

    await stopConversationJobs(services.runtime, conversationId)
    await jobReplyEnded

    expect(listJobStates(services, conversationId)).toEqual(["replied"])
    expect(services.reportEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "wake-up-started" })
    )
    expect(services.reportEvent).toHaveBeenCalledWith({
      kind: "wake-up-skipped",
      conversationId,
      reason: "no-wake-settings"
    })
    const next = createPersonTurn(services.conversation.turns, {
      kind: "existing",
      id: conversationId
    })
    expect(next.turn.userMessage.reports).toEqual([
      expect.objectContaining({ jobId: job.id, kind: "result" })
    ])
  })

  it("forgets the conversation's wake settings when the person stops the lead's reply, so a result that arrived during it waits for the person's next message", async () => {
    const services = openDelegationTestServices()
    const lead = startPersonTurn(services)
    const conversationId = lead.turn.conversation.id
    const finishedJob = sendJobMessage(services, lead, MOTHS_REQUEST)
    const workingJob = sendJobMessage(services, lead, ARCHIVE_REQUEST)
    await services.resolveReply(finishedJob.replyId, "completed")

    await stopReplyForPerson(services.runtime, buildReplyTarget(lead))

    expect(
      services.runtime.wakeSettings.findWakeSettings(conversationId)
    ).toEqual({ status: "none" })
    expect(services.reportEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "wake-up-started" })
    )
    const next = createPersonTurn(services.conversation.turns, {
      kind: "existing",
      id: conversationId
    })
    expect(next.turn.userMessage.reports).toHaveLength(2)
    expect(next.turn.userMessage.reports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ jobId: finishedJob.id, kind: "result" }),
        expect.objectContaining({ jobId: workingJob.id, kind: "stopped" })
      ])
    )
  })

  it("keeps the wake settings when the person stops one job in the job view, so the other jobs still wake the lead", async () => {
    const services = openDelegationTestServices()
    const lead = startPersonTurn(services)
    const conversationId = lead.turn.conversation.id
    const stoppedJob = sendJobMessage(services, lead, MOTHS_REQUEST)
    sendJobMessage(services, lead, ARCHIVE_REQUEST)

    await stopReplyForPerson(services.runtime, {
      conversationId: stoppedJob.id,
      assistantMessageId: stoppedJob.replyId
    })

    expect(
      services.runtime.wakeSettings.findWakeSettings(conversationId)
    ).toMatchObject({ status: "found" })
  })
})
