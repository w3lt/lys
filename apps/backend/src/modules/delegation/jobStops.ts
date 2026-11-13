import type { Job, JobState } from "@lys/share"
import type { StopJobOutcome } from "../agent/turnDelegation"
import type ReplyGeneration from "../chat/replyGeneration"
import {
  ReplyGenerationRegistryClosedError,
  type ReplyTarget
} from "../chat/replyGenerationRegistry"
import type { ReplyStopOutcome } from "../chat/replyStop"
import { waitForSettlementOrAbort } from "../../utils/abort"
import type { DelegationRuntime } from "./dependencies"
import type { ReplyAddress } from "./records"

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
 * What {@link stopReplyForPerson} and {@link stopConversationJobs} use of the
 * delegation runtime.
 */
export type PersonStopRuntime = Pick<
  DelegationRuntime,
  | "jobActivity"
  | "generations"
  | "stopRequests"
  | "wakeSettings"
  | "reportEvent"
>

/** A streaming reply whose generation runs, which the person may stop. */
type RunningReply = Readonly<{
  /** The reply and the conversation that holds it. */
  address: ReplyAddress
  /** The reply's running generation. */
  generation: ReplyGeneration
}>

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
 * Stops one reply for the person, with every working job below its
 * conversation, and waits until each stopped reply reached its stored final
 * state.
 *
 * @param runtime - The reply reader, the generation registry, the stop
 * requests, the wake settings, and the event reporter.
 * @param target - The reply and the conversation expected to hold it.
 * @returns `not-generating` when no generation runs for the reply in that
 * conversation, and nothing is stopped, forgotten, or reported; otherwise
 * `stopped`, once the reply task of the reply and of each stopped job reply
 * settled.
 * @throws If the conversation store is closed or a stored identity violates
 * the conversation contract; nothing is stopped then.
 * @remarks The stop is one synchronous step. The reply's generation is
 * found, then the streaming replies whose generations run: the reply itself
 * and those of the jobs below its conversation, at any depth. They are
 * stopped for the person as {@link stopRepliesForPerson} stops them, which
 * forgets the wake settings of the reply's conversation, and one
 * `stop-requested` is reported for that conversation. When the
 * reply already ended while its turn's title task runs, its generation is
 * asked to stop all the same, which leaves the title task running, and the
 * jobs below are stopped; the event does not count the reply then. Another
 * reply of the same conversation is left alone. A registry whose disposal
 * began has no running generation.
 */
export async function stopReplyForPerson(
  runtime: PersonStopRuntime,
  target: ReplyTarget
): Promise<ReplyStopOutcome> {
  const generation = findRunningReplyGeneration(runtime.generations, target)
  if (generation === undefined) return "not-generating"
  const replies = findRunningReplies(runtime, target.conversationId).filter(
    ({ address }) =>
      address.conversationId !== target.conversationId ||
      address.assistantMessageId === target.assistantMessageId
  )
  await Promise.all([
    stopRepliesForPerson(runtime, target.conversationId, replies),
    generation.stopReply()
  ])
  return "stopped"
}

/**
 * Stops every working job below a conversation for the person, and waits
 * until each stopped reply reached its stored final state.
 *
 * @param runtime - The reply reader, the generation registry, the stop
 * requests, the wake settings, and the event reporter.
 * @param conversationId - UUIDv7 of the conversation.
 * @returns A promise that resolves once the reply task of each stopped job
 * reply settled, right away when no job below the conversation works.
 * @throws If the conversation store is closed or a stored identity violates
 * the conversation contract; nothing is stopped then.
 * @remarks The stop is one synchronous step. The streaming replies of the
 * jobs below the conversation, at any depth, whose generations run are
 * found and stopped for the person as {@link stopRepliesForPerson} stops
 * them, which forgets the conversation's wake settings, and one
 * `stop-requested` is reported for the conversation, also when no job
 * works. The conversation's own replies are left alone. A registry whose
 * disposal began has no running generation.
 */
export async function stopConversationJobs(
  runtime: PersonStopRuntime,
  conversationId: string
): Promise<void> {
  const replies = findRunningReplies(runtime, conversationId).filter(
    ({ address }) => address.conversationId !== conversationId
  )
  await stopRepliesForPerson(runtime, conversationId, replies)
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
  return findRunningReplyGeneration(generations, {
    conversationId: job.id,
    assistantMessageId: job.replyId
  })
}

/**
 * Finds the running generation of one reply.
 *
 * @param generations - Finds the running generation of a reply.
 * @param target - The reply and the conversation expected to hold it.
 * @returns The generation; undefined when none runs for the reply in that
 * conversation, or once the registry's disposal began, which ends every
 * generation.
 */
export function findRunningReplyGeneration(
  generations: DelegationRuntime["generations"],
  target: ReplyTarget
): ReplyGeneration | undefined {
  try {
    return generations.findReplyGeneration(target)
  } catch (error) {
    if (error instanceof ReplyGenerationRegistryClosedError) return undefined
    throw error
  }
}

/**
 * Finds the streaming replies of a conversation, and of every job below it,
 * whose generations run.
 *
 * @param runtime - The reply reader and the generation registry.
 * @param conversationId - UUIDv7 of the conversation.
 * @returns A frozen list of frozen entries: the conversation's own
 * streaming reply first, then those of the jobs below it, at any depth, in
 * the order the jobs were created. A streaming reply without a running
 * generation is left out.
 * @throws If the conversation store is closed or a stored identity violates
 * the conversation contract.
 */
function findRunningReplies(
  runtime: Pick<PersonStopRuntime, "jobActivity" | "generations">,
  conversationId: string
): readonly RunningReply[] {
  const addresses = runtime.jobActivity.listStreamingReplies(conversationId)
  const replies: RunningReply[] = []
  for (const address of addresses) {
    const generation = findRunningReplyGeneration(runtime.generations, address)
    if (generation !== undefined)
      replies.push(Object.freeze({ address, generation }))
  }
  return Object.freeze(replies)
}

/**
 * Stops running replies for the person and waits until the reply task of
 * each settled.
 *
 * @param runtime - The stop requests, the wake settings, and the event
 * reporter.
 * @param conversationId - UUIDv7 of the conversation the person's stop
 * names.
 * @param replies - The running replies to stop.
 * @returns A promise that resolves once the reply task of each reply
 * settled, so its final state is stored.
 * @remarks In one synchronous step, the wake settings of the conversation
 * are forgotten first, so no wake-up turn starts there until the person
 * writes again: a stop never wakes the delegator, also when a job's reply
 * completes by itself as it is asked to stop. Only a main conversation has
 * wake settings, so a stop that names a job leaves those of its delegator,
 * whose other jobs still wake it. Then `person` is remembered as the stop
 * requester of each reply, which keeps an earlier request of the delegator
 * and which the reply's end removes, and the reply is asked to stop; then
 * one `stop-requested` is reported for the conversation with the number of
 * replies, also when there are none.
 */
async function stopRepliesForPerson(
  runtime: Pick<
    PersonStopRuntime,
    "stopRequests" | "wakeSettings" | "reportEvent"
  >,
  conversationId: string,
  replies: readonly RunningReply[]
): Promise<void> {
  runtime.wakeSettings.removeWakeSettings(conversationId)
  const replyEnds = replies.map(({ address, generation }) => {
    runtime.stopRequests.addStopRequest(address.assistantMessageId, "person")
    return generation.stopReply()
  })
  runtime.reportEvent({
    kind: "stop-requested",
    conversationId,
    requester: "person",
    stoppedReplyCount: replies.length
  })
  await Promise.all(replyEnds)
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
