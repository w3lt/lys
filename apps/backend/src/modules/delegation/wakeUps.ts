import type { ConversationAttachmentDraft } from "@lys/share"
import { v7 as uuidv7 } from "uuid"
import type Agent from "../agent/agent"
import type {
  ConversationTurnTarget,
  ConversationTurnUserMessage,
  CreateConversationTurnOptions
} from "../chat/persistence"
import type { TurnSettings } from "../chat/turnStart"
import type { DelegationEvent } from "./delegationEvent"
import type { DelegationRuntime } from "./dependencies"
import { formatWakeUpMessage } from "./wakeUpMessage"

/** What {@link startDueWakeUpTurn} uses of the delegation runtime. */
export type WakeUpRuntime = Pick<
  DelegationRuntime,
  | "jobs"
  | "jobActivity"
  | "wakeSettings"
  | "findConversationAgentCode"
  | "loadChatAgent"
  | "turns"
  | "startTurn"
  | "hooks"
  | "logger"
  | "hub"
  | "reportEvent"
>

/** Why a due wake-up turn does not start, as `wake-up-skipped` tells it. */
type WakeUpSkipReason = Extract<
  DelegationEvent,
  { kind: "wake-up-skipped" }
>["reason"]

/** A due wake-up turn that can start, with what it starts with. */
type ReadyWakeUp = Readonly<{
  /** Every check passed. */
  status: "ready"
  /** Agent of the conversation, which answers the turn. */
  agent: Agent
  /** The conversation's wake settings, which the turn is written with. */
  settings: TurnSettings
}>

/**
 * Whether a due wake-up turn of a conversation starts; `status` selects the
 * variant.
 */
type WakeUpStart =
  | ReadyWakeUp
  | Readonly<{
      /** The turn does not start, and the skip is reported. */
      status: "skipped"
      /** Why it does not start. */
      reason: WakeUpSkipReason
    }>
  | Readonly<{
      /**
       * The conversation is no longer stored, so the turn does not start,
       * and nothing is reported.
       */
      status: "conversation-missing"
    }>

/**
 * Starts a wake-up turn in a delegator's conversation when a report of its
 * jobs that wakes the delegator waits there, so the agent reads the
 * reports without waiting for the person.
 *
 * @param runtime - The job and reply readers, the wake settings, the agent
 * lookups, turn storage and start, the hooks of the turns it starts, the
 * hub, and the event reporter.
 * @param conversationId - UUIDv7 of the delegator's main conversation.
 * @throws If a store is closed or fails, or a stored value violates its
 * contract; or what the turn start throws when the wake-up reply cannot
 * start, after the reply was stored as interrupted and its end was handled.
 * The wake-up turn, and the reports it delivered, stay stored then.
 * @throws {TypeError} If the decision is one this module does not know.
 * @remarks Does nothing, and reports nothing, while no `result` or `failed`
 * report of the conversation's jobs waits to be delivered. Otherwise the
 * turn starts or is skipped as {@link findWakeUpStart} decides: a skip is
 * reported as `wake-up-skipped` with its reason, except for a conversation
 * that is no longer stored. A turn that starts is stored and started as
 * {@link startWakeUpTurn} describes. The checks and the start are one
 * synchronous step.
 */
export function startDueWakeUpTurn(
  runtime: WakeUpRuntime,
  conversationId: string
): void {
  if (!runtime.jobActivity.hasUndeliveredWakingReport(conversationId)) return
  const start = findWakeUpStart(runtime, conversationId)
  switch (start.status) {
    case "ready":
      startWakeUpTurn(runtime, conversationId, start)
      return
    case "skipped":
      runtime.reportEvent({
        kind: "wake-up-skipped",
        conversationId,
        reason: start.reason
      })
      return
    case "conversation-missing":
      return
    default: {
      const unhandledStart: never = start
      throw new TypeError(
        `Unhandled wake-up start: ${JSON.stringify(unhandledStart)}`
      )
    }
  }
}

/**
 * Decides whether a due wake-up turn of a conversation starts.
 *
 * @param runtime - The reply reader, the wake settings, and the agent
 * lookups.
 * @param conversationId - UUIDv7 of the delegator's main conversation.
 * @returns The first that applies, as a frozen value: `skipped` with
 * `reply-streaming` while a reply of the conversation streams, since the
 * reports reach the agent after that reply ends; `skipped` with
 * `shutting-down` once the wake settings are closed, or with
 * `no-wake-settings` when none is remembered for the conversation;
 * `conversation-missing` when the conversation is no longer stored;
 * `skipped` with `agent-missing` when its agent cannot be loaded; otherwise
 * `ready`, with the agent and the wake settings.
 * @throws If the reply store is closed.
 */
function findWakeUpStart(
  runtime: Pick<
    WakeUpRuntime,
    | "jobActivity"
    | "wakeSettings"
    | "findConversationAgentCode"
    | "loadChatAgent"
  >,
  conversationId: string
): WakeUpStart {
  if (runtime.jobActivity.hasStreamingReply(conversationId))
    return Object.freeze({ status: "skipped", reason: "reply-streaming" })
  const lookup = runtime.wakeSettings.findWakeSettings(conversationId)
  if (lookup.status === "closed")
    return Object.freeze({ status: "skipped", reason: "shutting-down" })
  if (lookup.status === "none")
    return Object.freeze({ status: "skipped", reason: "no-wake-settings" })
  const agentCode = runtime.findConversationAgentCode(conversationId)
  if (agentCode === undefined)
    return Object.freeze({ status: "conversation-missing" })
  const agent = runtime.loadChatAgent(agentCode)
  if (agent === undefined)
    return Object.freeze({ status: "skipped", reason: "agent-missing" })
  return Object.freeze({ status: "ready", agent, settings: lookup.settings })
}

/**
 * Stores a wake-up turn in a delegator's conversation and starts its reply.
 *
 * @param runtime - Turn storage and start, the job reader, the hooks of the
 * turns it starts, the hub, and the event reporter.
 * @param conversationId - UUIDv7 of the delegator's main conversation.
 * @param wakeUp - The conversation's agent and its wake settings.
 * @throws As {@link startDueWakeUpTurn} does.
 * @remarks The turn is stored as {@link buildWakeUpTurnOptions} builds it,
 * and its user message delivers every report of the conversation's jobs
 * that waits. Its reply starts with the wake settings, as a backend-started
 * turn with the runtime's hooks, so the agent may give more work. Then the
 * reply is added to the hub as a reply of a main conversation, and
 * `wake-up-started` is reported with the number of reports the turn
 * delivered.
 */
function startWakeUpTurn(
  runtime: Pick<
    WakeUpRuntime,
    "turns" | "jobs" | "startTurn" | "hooks" | "logger" | "hub" | "reportEvent"
  >,
  conversationId: string,
  wakeUp: ReadyWakeUp
): void {
  const { agent, settings } = wakeUp
  const turn = runtime.turns.createConversationTurn(
    buildWakeUpTurnOptions(runtime.jobs, conversationId, settings)
  )
  const generation = runtime.startTurn({
    turn,
    agent,
    settings,
    startedBy: "backend",
    delegation: runtime.hooks,
    logger: runtime.logger
  })
  const assistantMessageId = turn.assistantMessage.id
  runtime.hub.addReply(
    { conversationId, parentConversationId: null, assistantMessageId },
    generation
  )
  runtime.reportEvent({
    kind: "wake-up-started",
    conversationId,
    assistantMessageId,
    reportCount: turn.userMessage.reports.length
  })
}

/**
 * Builds what a wake-up turn is stored with.
 *
 * @param jobs - Reads the conversation's jobs.
 * @param conversationId - UUIDv7 of the delegator's main conversation.
 * @param settings - The conversation's wake settings.
 * @returns Frozen options: a wake-up of the stored conversation as the
 * target; a wake-up message with a fresh UUIDv7, no attachments, and the text
 * {@link formatWakeUpMessage} writes for the jobs that are still working,
 * in number order; and the settings' model.
 * @throws If the job store is closed or a stored job violates the job
 * contract.
 */
function buildWakeUpTurnOptions(
  jobs: DelegationRuntime["jobs"],
  conversationId: string,
  settings: TurnSettings
): CreateConversationTurnOptions {
  const workingJobs = jobs
    .listJobs(conversationId)
    .filter((job) => job.state === "working")
  const conversation: ConversationTurnTarget = Object.freeze({
    kind: "wake-up",
    id: conversationId
  })
  const attachments: readonly ConversationAttachmentDraft[] = Object.freeze([])
  const userMessage: ConversationTurnUserMessage = Object.freeze({
    id: uuidv7(),
    content: formatWakeUpMessage(workingJobs),
    attachments
  })
  return Object.freeze({ conversation, userMessage, model: settings.model })
}
