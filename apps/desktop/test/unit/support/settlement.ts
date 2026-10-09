/** Settlement of a promise as seen by a case that does not await it. */
export type SettlementState = "pending" | "fulfilled" | "rejected"

/**
 * Waits until every pending promise continuation has run.
 *
 * @returns Settlement on the next macrotask turn, after the microtask queue,
 * including continuations queued while it drains, is empty.
 * @remarks A barrier only for promise-only work; it does not wait for I/O or
 * timers started by the code under test. Under fake timers, which also fake
 * this zero-delay timer, use `vi.advanceTimersByTimeAsync(0)` instead.
 */
export async function waitForMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

/** Promise a case settles itself, with the functions that settle it. */
export type ControlledPromise<T> = Readonly<{
  /** Promise that stays pending until the case settles it. */
  promise: Promise<T>
  /**
   * Fulfills the promise.
   *
   * @param value - Fulfillment value.
   */
  resolve: (value: T) => void
  /**
   * Rejects the promise.
   *
   * @param reason - Rejection reason.
   */
  reject: (reason: unknown) => void
}>

/**
 * Creates a pending promise the case settles at a chosen point.
 *
 * @returns The promise and its settling functions.
 * @remarks Equivalent to `Promise.withResolvers`, which the renderer's ES2022
 * library declarations do not include.
 */
export function createControlledPromise<T>(): ControlledPromise<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return Object.freeze({ promise, resolve, reject })
}

/**
 * Creates a reader of a promise's settlement without awaiting the promise.
 *
 * @param promise - Promise the case checks at its barriers.
 * @returns A reader of the settlement seen so far; it changes only after the
 * promise's reactions have run, so read it after a barrier such as
 * {@link waitForMicrotasks}.
 * @remarks Creating the reader handles the promise's rejection, so a rejection
 * the case observes is never reported as unhandled.
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
