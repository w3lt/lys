import type { JobState } from "@lys/share"

/** The job a turn works on, as the turn's agent is told about it. */
export type JobTurn = Readonly<{
  /** Display name of the delegator, the agent that gave the work. */
  delegatorName: string
  /** Number of the job in the delegator's conversation; a positive integer. */
  jobNumber: number
}>

/**
 * What a turn's conversation and tool offer allow of delegation, before the
 * agent's role is applied.
 */
export type DelegationOffer = Readonly<{
  /**
   * Whether the conversation is a main one and the turn's tool offer names
   * `delegate_work`.
   */
  mayDelegate: boolean
  /** Whether the conversation had at least one job when the turn started. */
  hasJobs: boolean
  /** The job the turn works on; undefined outside a job's turn. */
  job: JobTurn | undefined
}>

/** One job message a `delegate_work` call asks to send. */
export type JobMessageDraft = Readonly<{
  /** Valid agent code of the agent that should do the work. */
  agentCode: string
  /**
   * Trimmed title of the work, on one line: 1 to `MAXIMUM_JOB_TITLE_LENGTH`
   * of `@lys/share` UTF-16 code units.
   */
  title: string
  /** Trimmed, non-empty instructions: all the agent sees of the work. */
  instructions: string
  /**
   * Number of the earlier job to continue, a positive integer; undefined to
   * start a new job.
   */
  jobNumber: number | undefined
  /** UUIDv7 of the `delegate_work` call that sends the message. */
  toolCallId: string
}>

/** Why a job message was not sent. */
export type JobMessageRefusal =
  | Readonly<{
      /** No agent, built-in or stored, has the code. */
      kind: "agent-not-found"
      /** Code the call named. */
      agentCode: string
    }>
  | Readonly<{
      /** The agent was deleted. */
      kind: "agent-deleted"
      /** Code the call named. */
      agentCode: string
    }>
  | Readonly<{
      /** The agent's role does not take work. */
      kind: "agent-cannot-take-work"
      /** Code the call named. */
      agentCode: string
    }>
  | Readonly<{
      /** The conversation has no job of the number. */
      kind: "job-not-found"
      /** Number the call named. */
      jobNumber: number
    }>
  | Readonly<{
      /** The job belongs to another agent than the one the call named. */
      kind: "job-has-another-agent"
      /** Number the call named. */
      jobNumber: number
      /** Code of the agent the job belongs to. */
      agentCode: string
    }>
  | Readonly<{
      /** The job's reply is still being written. */
      kind: "job-is-working"
      /** Number the call named. */
      jobNumber: number
    }>
  | Readonly<{
      /**
       * Agents have sent as many job messages in the conversation since the
       * person's last message as the limit allows.
       */
      kind: "limit-reached"
      /** That limit; a positive integer. */
      limit: number
    }>
  | Readonly<{
      /** The turn's conversation is no longer stored. */
      kind: "conversation-missing"
    }>

/** Outcome of sending one job message. */
export type JobMessageOutcome =
  | Readonly<{
      /** The message is stored, and the job's reply has started. */
      status: "sent"
      /** Number of the job the message went to. */
      jobNumber: number
      /** Display name of the agent that does the work. */
      agentName: string
      /** Title the job has now. */
      title: string
      /** Whether the message started the job; false when it continued one. */
      isNewJob: boolean
    }>
  | Readonly<{
      /** Nothing was stored, and nothing started. */
      status: "refused"
      /** Why. */
      refusal: JobMessageRefusal
    }>

/**
 * Outcome of storing a progress note: `stored`, or `job-missing` when the
 * turn's job is no longer stored.
 */
export type ProgressNoteOutcome = "stored" | "job-missing"

/** Outcome of stopping one job. */
export type StopJobOutcome =
  | Readonly<{
      /** The job was working, and the stop ended its reply. */
      status: "stopped"
      /** Number of the job. */
      jobNumber: number
    }>
  | Readonly<{
      /**
       * The job was not working, or its reply ended by itself before the
       * stop took effect.
       */
      status: "already-ended"
      /** Number of the job. */
      jobNumber: number
      /** State the job is in. */
      state: Exclude<JobState, "working">
    }>
  | Readonly<{
      /** The conversation has no job of the number. */
      status: "job-not-found"
      /** Number the call named. */
      jobNumber: number
    }>

/**
 * A turn's part in delegation, carried by the turn like its other per-turn
 * callbacks: what the turn may be offered, and what its three tools do.
 */
export type TurnDelegation = Readonly<{
  /** What the turn's conversation and tool offer allow. */
  offer: DelegationOffer
  /**
   * Sends one job message from the turn's conversation, in one synchronous
   * step: `sent` once the message is stored and the job's reply has
   * started, or `refused` with why, after storing nothing. Throws only on a
   * defect.
   */
  createJobMessage: (draft: JobMessageDraft) => JobMessageOutcome
  /**
   * Stores a trimmed, non-empty note on where the turn's job stands, in
   * place of the job's earlier note its delegator has not read yet. Throws
   * only on a defect.
   */
  createProgressNote: (note: string) => ProgressNoteOutcome
  /**
   * Stops one job of the turn's conversation, named by its number. Resolves
   * when the job's reply has reached its stored final state; rejects with
   * the abort reason when `abortSignal` aborts first.
   */
  stopJob: (
    jobNumber: number,
    abortSignal: AbortSignal
  ) => Promise<StopJobOutcome>
}>

/**
 * Fails a delegation call of a turn that takes no part in delegation.
 *
 * @throws Always: such a turn offers no delegation tool, so a call of one of
 * its callbacks is a defect.
 */
function handleUnofferedDelegationCall(): never {
  throw new Error("This turn takes no part in delegation")
}

/** Offer of a turn that takes no part in delegation: nothing. */
const NO_DELEGATION_OFFER: DelegationOffer = Object.freeze({
  mayDelegate: false,
  hasJobs: false,
  job: undefined
})

/**
 * Delegation of a turn that takes no part in delegation: it offers nothing,
 * and each callback throws.
 */
export const NO_TURN_DELEGATION: TurnDelegation = Object.freeze({
  offer: NO_DELEGATION_OFFER,
  createJobMessage: handleUnofferedDelegationCall,
  createProgressNote: handleUnofferedDelegationCall,
  stopJob: handleUnofferedDelegationCall
})
