import type { ConversationAttachmentDraft, Job } from "@lys/share"
import { v7 as uuidv7 } from "uuid"
import type {
  JobMessageDraft,
  JobMessageOutcome,
  JobMessageRefusal
} from "../agent/turnDelegation"
import type {
  ConversationTurn,
  ConversationTurnTarget,
  ConversationTurnUserMessage,
  CreateConversationTurnOptions
} from "../chat/persistence"
import type { TurnDelegationContext } from "../chat/turnStart"
import { ConversationNotFoundError } from "../../utils/errors"
import type { DelegationRuntime } from "./dependencies"
import {
  findJobMessageTarget,
  type JobMessageCheckRuntime,
  type JobMessageTarget,
  type RefusedJobMessage
} from "./jobMessageChecks"

/** What {@link createJobMessage} uses of the delegation runtime. */
export type JobMessageRuntime = JobMessageCheckRuntime &
  Pick<
    DelegationRuntime,
    | "turns"
    | "startTurn"
    | "handleTurnStarted"
    | "createTurnDelegation"
    | "handleReplyEnded"
    | "logger"
    | "wakeSettings"
    | "hub"
    | "reportEvent"
  >

/** One job message a turn sends: the turn that sends it, and what it says. */
type JobMessageRequest = Readonly<{
  /** The delegating turn, with its settings and who started it. */
  context: TurnDelegationContext
  /** What the `delegate_work` call asks. */
  draft: JobMessageDraft
}>

/** Where a job message goes, once every check passed. */
type FoundJobMessageTarget = Extract<JobMessageTarget, { status: "found" }>

/** A stored job turn, with the job as stored with it. */
type StoredJobTurn = Readonly<{
  /** The stored turn and the snapshot of the job before it. */
  turn: ConversationTurn
  /** The job, working on the turn's reply. */
  job: Job
}>

/**
 * Sends one job message from a turn's conversation, in one synchronous step:
 * checks it, stores the job turn, and starts the job's reply.
 *
 * @param runtime - Job records, agent lookups, turn storage and start, the
 * hooks of the turns it starts, the hub, the wake settings, and the event
 * reporter.
 * @param context - The delegating turn: its conversation, its settings, and
 * who started it.
 * @param draft - What the `delegate_work` call asks.
 * @returns `sent` with the job's number, the agent's display name, the
 * job's title, and whether the message started the job; or `refused` with
 * why, as {@link findJobMessageTarget} decides, or `conversation-missing`
 * when the delegator's conversation, or the continued job, is no longer
 * stored. A refused message stores and starts nothing, and is reported as
 * `job-message-refused`.
 * @throws If a store is closed or fails; or what the turn start throws when
 * the job's reply cannot start, after the reply was stored as interrupted
 * and its end was handled. The job turn stays stored then.
 * @remarks A sent message is stored as the job's message, by the delegator,
 * with the call's identity, and its reply is written with the delegating
 * turn's model. The reply starts with the delegating turn's settings, as a
 * backend-started turn with the runtime's hooks, so it takes part in
 * delegation as a job. Then the delegating turn's settings become the wake
 * settings of the delegator's conversation, the reply is added to the hub,
 * the job's update is sent, and `job-message-sent` is reported.
 */
export function createJobMessage(
  runtime: JobMessageRuntime,
  context: TurnDelegationContext,
  draft: JobMessageDraft
): JobMessageOutcome {
  const conversationId = context.turn.conversation.id
  const target = findJobMessageTarget(runtime, conversationId, draft)
  const request: JobMessageRequest = Object.freeze({ context, draft })
  const outcome =
    target.status === "found"
      ? sendJobMessage(runtime, request, target)
      : target
  if (outcome.status === "refused")
    runtime.reportEvent({
      kind: "job-message-refused",
      conversationId,
      agentCode: draft.agentCode,
      jobNumber: draft.jobNumber,
      reason: outcome.refusal.kind
    })
  return outcome
}

/**
 * Stores a checked job message as the job's turn and starts the job's reply.
 *
 * @param runtime - Turn storage and start, the hooks of the turns it
 * starts, the job reader, the hub, the wake settings, and the event
 * reporter.
 * @param request - The delegating turn and what its call asks.
 * @param target - The agent and the job the message goes to.
 * @returns `sent` once the reply started; the refusal `conversation-missing`
 * when the turn cannot be stored because its conversation or job is gone,
 * which stores nothing.
 * @throws As {@link createJobMessage} does.
 */
function sendJobMessage(
  runtime: Pick<
    JobMessageRuntime,
    | "turns"
    | "jobs"
    | "startTurn"
    | "handleTurnStarted"
    | "createTurnDelegation"
    | "handleReplyEnded"
    | "logger"
    | "wakeSettings"
    | "hub"
    | "reportEvent"
  >,
  request: JobMessageRequest,
  target: FoundJobMessageTarget
): JobMessageOutcome {
  /** Why a message is refused when its conversation is no longer stored. */
  const conversationMissingRefusal: JobMessageRefusal = Object.freeze({
    kind: "conversation-missing"
  })

  /** Answer to a job message whose conversation is no longer stored. */
  const conversationMissing: RefusedJobMessage = Object.freeze({
    status: "refused",
    refusal: conversationMissingRefusal
  })

  const stored = saveJobTurn(runtime, request, target.job)
  if (stored === undefined) return conversationMissing
  const { context, draft } = request
  const parentConversationId = context.turn.conversation.id
  const generation = runtime.startTurn({
    turn: stored.turn,
    agent: target.agent,
    settings: context.settings,
    startedBy: "backend",
    handleTurnStarted: runtime.handleTurnStarted,
    createTurnDelegation: runtime.createTurnDelegation,
    handleReplyEnded: runtime.handleReplyEnded,
    logger: runtime.logger
  })
  runtime.wakeSettings.addWakeSettings(parentConversationId, context.settings)
  runtime.hub.addReply(
    {
      conversationId: stored.job.id,
      parentConversationId,
      assistantMessageId: stored.turn.assistantMessage.id
    },
    generation
  )
  runtime.hub.sendJobUpdate(parentConversationId, stored.job)
  const isNewJob = stored.turn.isNewConversation
  runtime.reportEvent({
    kind: "job-message-sent",
    conversationId: parentConversationId,
    jobId: stored.job.id,
    jobNumber: stored.job.number,
    agentCode: stored.job.agentCode,
    isNewJob
  })
  return Object.freeze({
    status: "sent",
    jobNumber: stored.job.number,
    agentName: target.agentName,
    title: draft.title,
    isNewJob
  })
}

/**
 * Stores the turn of a checked job message and reads its job.
 *
 * @param runtime - Turn storage and the job reader.
 * @param request - The delegating turn and what its call asks.
 * @param job - The job to continue; undefined to start a new one.
 * @returns The stored turn with its job; undefined when the delegator's
 * conversation, or the continued job, is no longer stored, which stores
 * nothing.
 * @throws If the store is closed or the write fails, or the stored turn
 * has no job, which would be a defect of the store.
 */
function saveJobTurn(
  runtime: Pick<DelegationRuntime, "turns" | "jobs">,
  request: JobMessageRequest,
  job: Job | undefined
): StoredJobTurn | undefined {
  const turn = createJobTurn(runtime.turns, buildJobTurnOptions(request, job))
  if (turn === undefined) return undefined
  const record = runtime.jobs.findJob(turn.conversation.id)
  if (record === undefined) throw new Error("A stored job turn has no job")
  return Object.freeze({ turn, job: record.job })
}

/**
 * Stores one job turn.
 *
 * @param turns - Turn storage.
 * @param options - The job turn's target, message, and model.
 * @returns The stored turn; undefined when its target, the delegator's
 * conversation or the continued job, is not stored, which stores nothing.
 * @throws Every other failure of the store, unchanged.
 */
function createJobTurn(
  turns: DelegationRuntime["turns"],
  options: CreateConversationTurnOptions
): ConversationTurn | undefined {
  try {
    return turns.createConversationTurn(options)
  } catch (error) {
    if (error instanceof ConversationNotFoundError) return undefined
    throw error
  }
}

/**
 * Builds what the turn of a job message is stored with.
 *
 * @param request - The delegating turn and what its call asks.
 * @param job - The job to continue; undefined to start a new one.
 * @returns A new job of the named agent started from the delegating turn's
 * conversation, or the continued job, with the message's title and the
 * call's identity, so the message is a delegator's; the instructions as the
 * message; and the delegating turn's model. The new job and the message get
 * fresh UUIDv7 identities.
 */
function buildJobTurnOptions(
  { context, draft }: JobMessageRequest,
  job: Job | undefined
): CreateConversationTurnOptions {
  /** A job message has no attachments: the agent sees only the instructions. */
  const noAttachments: readonly ConversationAttachmentDraft[] = Object.freeze(
    []
  )

  const conversation = buildJobTurnTarget(
    context.turn.conversation.id,
    draft,
    job
  )
  const userMessage: ConversationTurnUserMessage = {
    id: uuidv7(),
    content: draft.instructions,
    attachments: noAttachments
  }
  return { conversation, userMessage, model: context.settings.model }
}

/**
 * Builds the conversation a job message is stored in.
 *
 * @param parentConversationId - UUIDv7 of the delegator's conversation.
 * @param draft - Agent and title the `delegate_work` call named, and the
 * call's identity.
 * @param job - The job to continue; undefined to start a new one.
 * @returns The continued job with the message's title, or a new job of the
 * named agent with a fresh UUIDv7 and the message's title; either carries
 * the call that sends the message.
 */
function buildJobTurnTarget(
  parentConversationId: string,
  draft: Pick<JobMessageDraft, "agentCode" | "title" | "toolCallId">,
  job: Job | undefined
): ConversationTurnTarget {
  if (job !== undefined)
    return {
      kind: "existing-job",
      id: job.id,
      title: draft.title,
      jobCallId: draft.toolCallId
    }
  return {
    kind: "new-job",
    id: uuidv7(),
    agentCode: draft.agentCode,
    parentConversationId,
    title: draft.title,
    jobCallId: draft.toolCallId
  }
}
