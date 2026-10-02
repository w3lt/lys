/**
 * Waits until every pending promise continuation has run.
 *
 * @returns Settlement on the next macrotask turn, after the microtask queue,
 * including continuations queued while it drains, is empty.
 * @remarks A barrier only for promise-only work; it does not wait for I/O or
 * timers started by the code under test.
 */
export async function waitForMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve)
  })
}
