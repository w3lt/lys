import type { ReplyTarget } from "./replyGenerationRegistry"

/**
 * What the person's stop of one reply did: `stopped` once the reply and
 * every working job below its conversation were stopped; `not-generating`
 * when no generation runs for the reply, so nothing was stopped.
 */
export type ReplyStopOutcome = "stopped" | "not-generating"

/**
 * Stops one reply for the person, with every working job below its
 * conversation; bound to the delegation runtime by the composition root.
 *
 * @param target - The reply and the conversation expected to hold it.
 * @returns A promise that resolves with `stopped` once each stopped reply
 * reached its stored final state, or with `not-generating` when no
 * generation runs for the reply in that conversation, also once the reply
 * generation registry's disposal began, which ends every generation.
 * @throws If the conversation store is closed or a stored identity violates
 * the conversation contract; nothing is stopped then.
 */
export type StopReply = (target: ReplyTarget) => Promise<ReplyStopOutcome>
