import {
  buildDelegationOffer,
  type TurnDelegation
} from "../agent/turnDelegation"
import type { TurnDelegationContext } from "../chat/turnStart"
import type { DelegationRuntime } from "./dependencies"
import { createJobMessage, type JobMessageRuntime } from "./jobMessages"
import { stopJob, type JobStopRuntime } from "./jobStops"
import { createProgressNote, type ProgressNoteRuntime } from "./progressNotes"

/** What {@link handleTurnStarted} uses of the delegation runtime. */
export type TurnStartRuntime = Pick<DelegationRuntime, "wakeSettings">

/**
 * What {@link createTurnDelegation} uses of the delegation runtime: the
 * agent lookup that names a job's delegator, and what the turn's three
 * callbacks use.
 */
export type TurnDelegationRuntime = Pick<DelegationRuntime, "findAgent"> &
  JobMessageRuntime &
  ProgressNoteRuntime &
  JobStopRuntime

/**
 * Handles the start of a turn started with the delegation hooks: takes or
 * drops the wake settings of a main conversation when the person writes in
 * it.
 *
 * @param runtime - The wake settings.
 * @param context - The starting turn, its settings, and who started it.
 * @remarks For a person's turn in a main conversation, the turn's settings
 * become the conversation's wake settings while a job of the conversation
 * is working, as its snapshot before the turn shows; with no working job,
 * the conversation's wake settings are removed. Every other turn changes
 * nothing.
 */
export function handleTurnStarted(
  runtime: TurnStartRuntime,
  context: TurnDelegationContext
): void {
  const { conversation } = context.turn
  const isMainConversation = conversation.kind === "main"
  if (context.startedBy !== "person" || !isMainConversation) return
  if (conversation.jobs.some((job) => job.state === "working"))
    runtime.wakeSettings.addWakeSettings(conversation.id, context.settings)
  else runtime.wakeSettings.removeWakeSettings(conversation.id)
}

/**
 * Creates the part a starting turn takes in delegation.
 *
 * @param runtime - The agent lookup that names a job's delegator, and what
 * the delegation's callbacks run with.
 * @param context - The starting turn, its settings, and who started it.
 * @returns The frozen delegation. Its offer is built from the turn's
 * conversation snapshot and settings, as {@link buildDelegationOffer}
 * builds it, with the delegator's display name. Its callbacks send job
 * messages, store progress notes, and stop jobs for this turn, as
 * {@link createJobMessage}, {@link createProgressNote}, and {@link stopJob}
 * do.
 */
export function createTurnDelegation(
  runtime: TurnDelegationRuntime,
  context: TurnDelegationContext
): TurnDelegation {
  const { conversation } = context.turn
  const offer = buildDelegationOffer(
    conversation,
    context.settings.offersDelegateWork,
    (code) => runtime.findAgent(code)?.agent.name
  )
  return Object.freeze({
    offer,
    createJobMessage: (draft) => createJobMessage(runtime, context, draft),
    createProgressNote: (note) => createProgressNote(runtime, context, note),
    stopJob: (jobNumber, abortSignal) =>
      stopJob(runtime, {
        conversationId: conversation.id,
        jobNumber,
        abortSignal
      })
  })
}
