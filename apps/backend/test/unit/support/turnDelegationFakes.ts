import type {
  DelegationOffer,
  TurnDelegation
} from "../../../src/modules/agent/turnDelegation"
import type { StartTurnOptions } from "../../../src/modules/chat/turnStart"

/**
 * The delegation callbacks one case arranges; a call of one it leaves out
 * fails the case.
 */
export type TurnDelegationCallbacks = Readonly<{
  /** Answers each job message the turn sends. */
  createJobMessage?: TurnDelegation["createJobMessage"]
  /** Answers each progress note the turn stores. */
  createProgressNote?: TurnDelegation["createProgressNote"]
  /** Answers each stop the turn asks for. */
  stopJob?: TurnDelegation["stopJob"]
}>

/** Callbacks of a case that arranges none. */
const NO_DELEGATION_CALLBACKS: TurnDelegationCallbacks = Object.freeze({})

/**
 * Fails a delegation call that the current case did not arrange.
 *
 * @throws Always.
 */
export function handleUnexpectedDelegationCall(): never {
  throw new Error("Unexpected delegation call")
}

/**
 * Builds the delegation of one case's turn.
 *
 * @param offer - What the turn's conversation and tool offer allow.
 * @param callbacks - The callbacks the case arranges; none by default.
 * @returns The frozen delegation: the offer, the arranged callbacks, and a
 * callback that throws for each one the case left out.
 */
export function buildTurnDelegation(
  offer: DelegationOffer,
  callbacks: TurnDelegationCallbacks = NO_DELEGATION_CALLBACKS
): TurnDelegation {
  return Object.freeze({
    offer,
    createJobMessage:
      callbacks.createJobMessage ?? handleUnexpectedDelegationCall,
    createProgressNote:
      callbacks.createProgressNote ?? handleUnexpectedDelegationCall,
    stopJob: callbacks.stopJob ?? handleUnexpectedDelegationCall
  })
}

/** Offer of a turn that takes no part in delegation: nothing. */
const NO_DELEGATION_OFFER: DelegationOffer = Object.freeze({
  mayDelegate: false,
  hasJobs: false,
  job: undefined
})

/**
 * Delegation of a case's turn that takes no part in delegation: it offers
 * nothing, and a call of any of its callbacks fails the case.
 */
export const NO_TURN_DELEGATION: TurnDelegation =
  buildTurnDelegation(NO_DELEGATION_OFFER)

/**
 * Hooks of a case's starter whose turns take no part in delegation, to
 * spread into a turn start's options: they do nothing when a turn starts or
 * a reply ends, and every turn gets {@link NO_TURN_DELEGATION}.
 */
export const NO_TURN_DELEGATION_HOOKS: Pick<
  StartTurnOptions,
  "handleTurnStarted" | "createTurnDelegation" | "handleReplyEnded"
> = Object.freeze({
  handleTurnStarted: () => undefined,
  createTurnDelegation: () => NO_TURN_DELEGATION,
  handleReplyEnded: () => undefined
})
