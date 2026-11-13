import type { Job, JobState } from "@lys/share"
import type { StopJobOutcome } from "../agent/turnDelegation"
import type ReplyGeneration from "../chat/replyGeneration"
import {
  ReplyGenerationRegistryClosedError,
  type ReplyTarget
} from "../chat/replyGenerationRegistry"
import { waitForSettlementOrAbort } from "../../utils/abort"
import type { DelegationRuntime } from "./dependencies"

/** One job a delegator asks to stop. */
export type StopJobRequest = Readonly<{
  /** UUIDv7 of the delegator's conversation, which the job belongs to. */
  conversationId: string
  /** Number of the job in that conversation, from 1. */
  jobNumber: number
  /**
   * Cancellation of the wait for the job's reply to end; aborting it does
   * not take the stop back.
   */
  abortSignal: AbortSignal
}>

/** What {@link stopJob} uses of the delegation runtime. */
export type JobStopRuntime = Pick<
  DelegationRuntime,
  "jobs" | "generations" | "stopRequests" | "reportEvent"
>

/**
 * Stops one working job of a delegator's conversation and waits until its
 * reply has reached its stored final state.
 *
 * @param runtime - The job reader, the generation registry, the stop
 * requests, and the event reporter.
 * @param request - The delegator's conversation, the job's number, and the
 * cancellation of the wait.
 * @returns `job-not-found` for a number no job of the conversation has;
 * `already-ended` with the job's state when it is not working or its reply
 * has no running generation; otherwise, once the reply ended, `stopped`
 * when the job reads as stopped, or `already-ended` with its state when the
 * reply ended by itself before the stop took effect.
 * @throws The abort reason when `abortSignal` aborts before the reply
 * ended; the reply is still stopped. Also if the job store is closed.
 * @remarks The stop is one synchronous step: the running generation is
 * found, `delegator` is remembered as the reply's stop requester, which the
 * reply's end removes, the reply is asked to stop, and `stop-requested` is
 * reported for the job's own conversation. A registry whose disposal began
 * has no running generation. A job without a running generation whose
 * reply still reads as working ends as interrupted, so it is answered as
 * `interrupted`.
 */
export async function stopJob(
  runtime: JobStopRuntime,
  request: StopJobRequest
): Promise<StopJobOutcome> {
  const { conversationId, jobNumber } = request
  const job = runtime.jobs.findJobByNumber(conversationId, jobNumber)
  if (job === undefined) return buildJobNotFoundOutcome(jobNumber)
  const generation = findWorkingReplyGeneration(runtime.generations, job)
  if (generation === undefined) return buildAlreadyEndedOutcome(job)
  runtime.stopRequests.addStopRequest(job.replyId, "delegator")
  const replyEnded = generation.stopReply()
  runtime.reportEvent({
    kind: "stop-requested",
    conversationId: job.id,
    requester: "delegator",
    stoppedReplyCount: 1
  })
  await waitForSettlementOrAbort(replyEnded, request.abortSignal)
  const stoppedJob = runtime.jobs.findJobByNumber(conversationId, jobNumber)
  if (stoppedJob === undefined) return buildJobNotFoundOutcome(jobNumber)
  if (stoppedJob.state === "stopped")
    return Object.freeze({ status: "stopped", jobNumber })
  return buildAlreadyEndedOutcome(stoppedJob)
}

/**
 * Finds the running generation of a working job's reply.
 *
 * @param generations - Finds the running generation of a reply.
 * @param job - The job, as read.
 * @returns The generation of the job's reply; undefined when the job is not
 * working, its reply has no running generation, or the registry's disposal
 * began, which ends every generation.
 */
function findWorkingReplyGeneration(
  generations: DelegationRuntime["generations"],
  job: Job
): ReplyGeneration | undefined {
  if (job.state !== "working") return undefined
  const target: ReplyTarget = {
    conversationId: job.id,
    assistantMessageId: job.replyId
  }
  try {
    return generations.findReplyGeneration(target)
  } catch (error) {
    if (error instanceof ReplyGenerationRegistryClosedError) return undefined
    throw error
  }
}

/**
 * Builds the answer for a job number no job of the conversation has.
 *
 * @param jobNumber - Number the call named.
 * @returns The frozen `job-not-found` outcome.
 */
function buildJobNotFoundOutcome(jobNumber: number): StopJobOutcome {
  return Object.freeze({ status: "job-not-found", jobNumber })
}

/**
 * Builds the answer for a job whose reply was not stopped by this call.
 *
 * @param job - The job, as read.
 * @returns The frozen `already-ended` outcome with the job's number and
 * state; a job that still reads as working is answered as `interrupted`,
 * the state its reply ends in.
 */
function buildAlreadyEndedOutcome(job: Job): StopJobOutcome {
  const state = calculateEndedJobState(job.state)
  return Object.freeze({
    status: "already-ended",
    jobNumber: job.number,
    state
  })
}

/**
 * Calculates the state a job is in once its reply has ended.
 *
 * @param state - The job's state as read.
 * @returns The state itself for an ended job; `interrupted` for a job that
 * reads as working, whose reply has no running generation and so ends as
 * interrupted.
 */
function calculateEndedJobState(state: JobState): Exclude<JobState, "working"> {
  return state === "working" ? "interrupted" : state
}
