/** Settlement of a promise as seen by a case that does not await it. */
export type SettlementState = "pending" | "fulfilled" | "rejected"

/**
 * Creates a reader of a promise's settlement without awaiting the promise.
 *
 * @param promise - Promise the case checks at its barriers.
 * @returns A reader of the settlement seen so far; it changes only after the
 * promise's reactions have run, so read it after a barrier such as
 * `waitForMicrotasks`.
 * @remarks Creating the reader handles the promise's rejection, so a rejection the case
 * observes is never reported as unhandled.
 */
export function createSettlementReader(
  promise: Promise<unknown>
): () => SettlementState {
  let state: SettlementState = "pending"
  void promise.then(
    () => {
      state = "fulfilled"
    },
    () => {
      state = "rejected"
    }
  )
  return () => state
}
