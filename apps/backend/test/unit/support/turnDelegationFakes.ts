import type {
  DelegationOffer,
  TurnDelegation
} from "../../../src/modules/agent/turnDelegation"

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
