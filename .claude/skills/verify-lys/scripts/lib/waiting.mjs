/**
 * Bounded waiting for the verification harness.
 *
 * @remarks Every wait has a deadline and names what it waited for, so a
 * stuck app ends a run with a readable failure instead of hanging it.
 */

/** Error raised when a condition does not hold before its deadline. */
export class WaitTimeoutError extends Error {
  /**
   * @param {string} description - What was waited for, in user terms.
   * @param {number} timeoutMs - The deadline that passed, in milliseconds.
   * @param {string | undefined} lastDetail - The last observation, when the
   * check reported one.
   */
  constructor(description, timeoutMs, lastDetail) {
    const detail = lastDetail === undefined ? "" : ` Last seen: ${lastDetail}`
    super(
      `Timed out after ${timeoutMs} ms waiting for ${description}.${detail}`
    )
    this.name = "WaitTimeoutError"
  }
}

/**
 * Options of {@link waitForCondition}.
 *
 * @typedef {object} WaitOptions
 * @property {string} description - What is awaited, named for the time-out
 * message.
 * @property {number} timeoutMs - Deadline from the first check, in
 * milliseconds.
 * @property {number} [intervalMs] - Pause between checks, in milliseconds.
 * Defaults to 250.
 * @property {() => unknown} check - Observes the condition. Returns a truthy
 * value once it holds, or `undefined`/`false` to keep waiting. A thrown
 * error is treated as "not yet" and its message becomes the last detail.
 */

/**
 * Pauses the caller for a fixed time.
 *
 * @param {number} delayMs - Pause length in milliseconds.
 * @returns {Promise<void>} A promise that resolves after the pause.
 */
export function waitForDelay(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

/**
 * Polls a condition until it holds or its deadline passes.
 *
 * @param {WaitOptions} options - The condition, its deadline, and its name.
 * @returns {Promise<unknown>} A promise that resolves to the first truthy
 * check result.
 * @throws {WaitTimeoutError} If the deadline passes first.
 */
export async function waitForCondition(options) {
  const intervalMs = options.intervalMs ?? 250
  const deadline = Date.now() + options.timeoutMs
  let lastDetail
  while (Date.now() < deadline) {
    const observation = await observeCondition(options.check)
    if (observation.held) return observation.value
    lastDetail = observation.detail ?? lastDetail
    await waitForDelay(intervalMs)
  }
  throw new WaitTimeoutError(options.description, options.timeoutMs, lastDetail)
}

/**
 * Runs one check and translates its outcome into a held/not-held record.
 *
 * @param {() => unknown} check - The condition's observer.
 * @returns {Promise<{held: boolean, value?: unknown, detail?: string}>}
 * Whether the condition held, its value, and the latest detail.
 */
async function observeCondition(check) {
  try {
    const value = await check()
    if (value) return { held: true, value }
    return { held: false, detail: formatObservation(value) }
  } catch (error) {
    return { held: false, detail: formatObservation(error) }
  }
}

/**
 * Formats a check's non-truthy result or error for a time-out message.
 *
 * @param {unknown} value - The result or the thrown error.
 * @returns {string | undefined} A short description, or `undefined` for a
 * plain `false`.
 */
function formatObservation(value) {
  if (value === false || value === undefined || value === null) return undefined
  if (value instanceof Error) return value.message
  return JSON.stringify(value)
}
