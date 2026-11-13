import type { Job } from "@lys/share"
import type Agent from "../agent/agent"
import { calculateAgentRole, hasAgentPermission } from "../agent/agentRoles"
import type {
  JobMessageDraft,
  JobMessageOutcome,
  JobMessageRefusal
} from "../agent/turnDelegation"
import type { DelegationRuntime } from "./dependencies"

/** A job message that is refused, as its sender is answered. */
export type RefusedJobMessage = Extract<
  JobMessageOutcome,
  { status: "refused" }
>

/** Where a job message goes once every check passed, or why it is refused. */
export type JobMessageTarget =
  | Readonly<{
      /** Every check passed. */
      status: "found"
      /** Live agent that does the work. */
      agent: Agent
      /** Display name of that agent. */
      agentName: string
      /** The job the message continues; undefined for a new job. */
      job: Job | undefined
    }>
  | RefusedJobMessage

/** What {@link findJobMessageTarget} uses of the delegation runtime. */
export type JobMessageCheckRuntime = Pick<
  DelegationRuntime,
  "jobs" | "agentJobMessageLimit" | "findAgent" | "loadChatAgent"
>

/** The agent a job message may go to. */
type FoundJobMessageAgent = Readonly<{
  /** The agent may take the work. */
  status: "found"
  /** Its live instance. */
  agent: Agent
  /** Its display name. */
  agentName: string
}>

/** The job a job message continues, or none for a new job. */
type FoundContinuedJob = Readonly<{
  /** The message may continue the job, or start a new one. */
  status: "found"
  /** The job to continue; undefined for a new job. */
  job: Job | undefined
}>

/**
 * Finds where a job message of a conversation goes, checking it in one
 * synchronous step, in this order: the limit of job messages, the agent,
 * and, for a continuation, the job.
 *
 * @param runtime - The job reader, the limit, and the agent lookups.
 * @param conversationId - UUIDv7 of the delegator's conversation, which the
 * message is sent from.
 * @param draft - What the `delegate_work` call asks.
 * @returns `found` with the live agent, its display name, and the job to
 * continue; or the frozen refusal of the first check that failed:
 * `limit-reached` once the conversation's jobs received as many job
 * messages since the person's last message there as the limit allows;
 * `agent-not-found`, `agent-deleted`, or `agent-cannot-take-work` for a
 * code no agent has, an agent that was deleted, or one whose role takes no
 * work;
 * `job-not-found` for a number no job of this conversation has;
 * `job-has-another-agent` for another agent's job; and `job-is-working`
 * for a job whose reply is still being written.
 * @throws If the job or agent store is closed or holds an invalid value.
 * @remarks Changes nothing. A leader never takes work, so an agent never
 * sends a job message to itself.
 */
export function findJobMessageTarget(
  runtime: JobMessageCheckRuntime,
  conversationId: string,
  draft: Pick<JobMessageDraft, "agentCode" | "jobNumber">
): JobMessageTarget {
  const limitRefusal = findLimitRefusal(runtime, conversationId)
  if (limitRefusal !== undefined) return limitRefusal
  const member = findJobMessageAgent(runtime, draft.agentCode)
  if (member.status === "refused") return member
  const continued = findContinuedJob(runtime.jobs, conversationId, draft)
  if (continued.status === "refused") return continued
  return Object.freeze({
    status: "found",
    agent: member.agent,
    agentName: member.agentName,
    job: continued.job
  })
}

/**
 * Finds the refusal of a job message the limit does not allow.
 *
 * @param runtime - The job reader and the limit.
 * @param conversationId - UUIDv7 of the delegator's conversation.
 * @returns The `limit-reached` refusal with the limit once the
 * conversation's jobs received that many job messages since the person's
 * last message there; undefined while fewer.
 * @throws If the job store is closed.
 */
function findLimitRefusal(
  runtime: Pick<DelegationRuntime, "jobs" | "agentJobMessageLimit">,
  conversationId: string
): RefusedJobMessage | undefined {
  const limit = runtime.agentJobMessageLimit
  const messageCount =
    runtime.jobs.getJobMessageCountSincePersonMessage(conversationId)
  if (messageCount < limit) return undefined
  return buildRefusedJobMessage({ kind: "limit-reached", limit })
}

/**
 * Finds the agent a job message may go to.
 *
 * @param runtime - The agent lookups.
 * @param agentCode - Code the `delegate_work` call named.
 * @returns `found` with the live agent and its display name; or the
 * refusal `agent-not-found` when no agent has the code or none can be
 * loaded, `agent-deleted` when its agent was deleted, or
 * `agent-cannot-take-work` when its role does not take work.
 * @throws If the agent store is closed or holds an invalid agent.
 */
function findJobMessageAgent(
  runtime: Pick<DelegationRuntime, "findAgent" | "loadChatAgent">,
  agentCode: string
): FoundJobMessageAgent | RefusedJobMessage {
  const found = runtime.findAgent(agentCode)
  if (found === undefined)
    return buildRefusedJobMessage({ kind: "agent-not-found", agentCode })
  if (found.deletedAt !== null)
    return buildRefusedJobMessage({ kind: "agent-deleted", agentCode })
  const role = calculateAgentRole(found.agent.kind)
  if (!hasAgentPermission(role, "take-work"))
    return buildRefusedJobMessage({ kind: "agent-cannot-take-work", agentCode })
  const agent = runtime.loadChatAgent(agentCode)
  if (agent === undefined)
    return buildRefusedJobMessage({ kind: "agent-not-found", agentCode })
  return Object.freeze({ status: "found", agent, agentName: found.agent.name })
}

/**
 * Finds the job a job message continues.
 *
 * @param jobs - Reads a job of the conversation by its number.
 * @param conversationId - UUIDv7 of the delegator's conversation.
 * @param draft - Agent and job number the `delegate_work` call named.
 * @returns `found` without a job for a message without a job number; `found`
 * with the job for a job of this conversation that belongs to the named
 * agent and is not working; otherwise the refusal `job-not-found`,
 * `job-has-another-agent` with the job's agent, or `job-is-working`.
 * @throws If the job store is closed or holds an invalid job.
 */
function findContinuedJob(
  jobs: Pick<DelegationRuntime["jobs"], "findJobByNumber">,
  conversationId: string,
  draft: Pick<JobMessageDraft, "agentCode" | "jobNumber">
): FoundContinuedJob | RefusedJobMessage {
  /** Answer of the job check for a message that starts a new job. */
  const newJob: FoundContinuedJob = Object.freeze({
    status: "found",
    job: undefined
  })

  const { jobNumber } = draft
  if (jobNumber === undefined) return newJob
  const job = jobs.findJobByNumber(conversationId, jobNumber)
  if (job === undefined)
    return buildRefusedJobMessage({ kind: "job-not-found", jobNumber })
  if (job.agentCode !== draft.agentCode)
    return buildRefusedJobMessage({
      kind: "job-has-another-agent",
      jobNumber,
      agentCode: job.agentCode
    })
  if (job.state === "working")
    return buildRefusedJobMessage({ kind: "job-is-working", jobNumber })
  return Object.freeze({ status: "found", job })
}

/**
 * Builds the answer to a refused job message.
 *
 * @param refusal - Why the message is refused.
 * @returns The frozen `refused` outcome with a frozen copy of the
 * refusal.
 */
function buildRefusedJobMessage(refusal: JobMessageRefusal): RefusedJobMessage {
  const ownRefusal: JobMessageRefusal = Object.freeze({ ...refusal })
  return Object.freeze({ status: "refused", refusal: ownRefusal })
}
