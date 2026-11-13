import type { TurnDelegationHooks } from "../chat/turnStart"
import type { DelegationDependencies, DelegationRuntime } from "./dependencies"
import { handleReplyEnded } from "./replyEnds"
import { createTurnDelegation, handleTurnStarted } from "./turnDelegations"

/**
 * Creates the runtime every delegation policy runs with: the place where
 * the policies and the hooks they hand to the turns they start are tied
 * together.
 *
 * @param dependencies - Collaborators borrowed from the composition root,
 * for as long as turns are started and their generations run.
 * @returns The frozen runtime: the dependencies, and hooks that call
 * {@link handleTurnStarted}, {@link createTurnDelegation}, and
 * {@link handleReplyEnded} with the runtime itself. A turn started with the
 * hooks takes part in delegation through the same policies, a job's turn
 * included.
 * @remarks The runtime refers to itself only inside the hooks' callbacks,
 * which run once a turn starts, after the runtime exists. Nothing is read
 * or started at creation.
 */
export function createDelegationRuntime(
  dependencies: DelegationDependencies
): DelegationRuntime {
  const hooks: TurnDelegationHooks = Object.freeze({
    handleTurnStarted: (context) => {
      handleTurnStarted(runtime, context)
    },
    createTurnDelegation: (context) => createTurnDelegation(runtime, context),
    handleReplyEnded: (reply) => {
      handleReplyEnded(runtime, reply)
    }
  })
  const runtime: DelegationRuntime = Object.freeze({ ...dependencies, hooks })
  return runtime
}
