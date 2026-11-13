import type { Job, JobState } from "@lys/share"
import { v7 as uuidv7 } from "uuid"
import { describe, expect, it, vi } from "vitest"
import { stopJob } from "../../../../src/modules/delegation/jobStops"
import type { NewEndReport } from "../../../../src/modules/delegation/records"
import {
  createPersonTurn,
  MOTHS_REQUEST,
  openDelegationTestServices,
  sendJobMessage,
  type DelegationTestServices
} from "../../support/delegationTestServices"
import { waitForMicrotasks } from "../../support/microtasks"

/** Cancellation of a wait that a case never cancels. */
const NEVER_ABORTED_SIGNAL = new AbortController().signal

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
 * Ends a job's reply as interrupted with an end report that says so, as
 * the backend records a reply its shutdown cut off.
 *
 * @param services - The case's controls and report store.
 * @param job - The working job.
 * @returns A promise that resolves once the reply's end was handled and
 * the report was stored.
 * @throws If the report is not stored.
 */
async function interruptJob(
  services: DelegationTestServices,
  job: Job
): Promise<void> {
  await services.resolveReply(job.replyId, "interrupted")
  const createdAt = new Date().toISOString()
  const report: NewEndReport = {
    id: uuidv7(),
    jobId: job.id,
    replyId: job.replyId,
    kind: "interrupted",
    title: job.title,
    content: "",
    createdAt
  }
  if (!services.runtime.reports.createEndReport(report))
    throw new Error("The end report was not stored")
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
    expect(services.reportEvent).toHaveBeenLastCalledWith({
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
