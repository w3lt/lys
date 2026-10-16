/**
 * Waits for a step to settle unless the signal aborts first.
 *
 * @param step - Pending work owned elsewhere; aborting the signal does not
 * stop it.
 * @param signal - Cancellation of this wait only.
 * @returns The step's result when it settles first.
 * @throws The step's failure when it settles first; and the signal's abort
 * reason when it aborts first or was already aborted.
 * @remarks Aborting ends only the wait: the step keeps running under its
 * owner, and its later outcome is observed and ignored, so a later rejection
 * is never unhandled.
 */
export async function waitForSettlementOrAbort<TResult>(
  step: Promise<TResult>,
  signal: AbortSignal
): Promise<TResult> {
  const { promise: aborted, reject } = Promise.withResolvers<never>()
  const rejectAborted = () => reject(signal.reason)
  signal.addEventListener("abort", rejectAborted, { once: true })
  if (signal.aborted) rejectAborted()
  try {
    return await Promise.race([step, aborted])
  } finally {
    signal.removeEventListener("abort", rejectAborted)
  }
}
