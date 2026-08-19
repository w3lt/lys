import { REPLIES } from "./content"

/** Controls one timer-backed demonstration simulation. */
export interface SimulationController {
  /** Cancels future timer callbacks; completion is not reported after cancellation. */
  cancel(): void
}

/** Inputs for a simulation that emits text in fixed-size chunks. */
export interface TextSimulationOptions {
  /** Complete text to emit in order. */
  text: string
  /** Number of UTF-16 code units emitted per timer tick; finite positive input is required for completion, but not validated. */
  chunkSize: number
  /** Delay between emissions, in milliseconds; no timing input is validated. */
  intervalMs: number
  /**
   * Receives each text chunk in order, including an empty chunk for empty input.
   *
   * @param text - Chunk emitted for the current timer tick.
   */
  onChunk(text: string): void
  /** Runs once after the final chunk has been emitted. */
  onComplete(): void
}

/** Inputs for a simulation that advances a percentage progress value. */
export interface ProgressSimulationOptions {
  /** Delay between progress updates, in milliseconds; no timing input is validated. */
  intervalMs: number
  /** Percentage points added on each timer tick; finite positive input is required for completion, but not validated. */
  step: number
  /**
   * Receives progress after the current upper-bound cap at 100. Finite
   * positive steps normally produce values from zero through 100; negative,
   * infinite, or `NaN` inputs can produce values outside that range.
   *
   * @param progress - Current simulated percentage.
   */
  onProgress(progress: number): void
  /** Runs once when progress reaches 100. */
  onComplete(): void
}

/**
 * Starts a timer-backed text simulation.
 *
 * @remarks No input validation is performed. Completion requires a finite,
 * positive `chunkSize`; empty text emits one empty chunk on the first timer
 * tick and then completes unless a callback cancels it. Cancellation clears the
 * interval and suppresses later callbacks.
 * @param options - Text, timing, and callback ownership for the simulation.
 * @returns A controller whose cancellation clears the timer and suppresses later callbacks.
 */
export function createTextSimulation({
  text,
  chunkSize,
  intervalMs,
  onChunk,
  onComplete
}: TextSimulationOptions): SimulationController {
  let index = 0
  let cancelled = false
  const timer = window.setInterval(() => {
    if (cancelled) return

    const nextIndex = Math.min(text.length, index + chunkSize)
    onChunk(text.slice(index, nextIndex))
    if (cancelled) return

    index = nextIndex

    if (index === text.length) {
      window.clearInterval(timer)
      onComplete()
    }
  }, intervalMs)

  return {
    /** Stops the interval and prevents any later text or completion callback. */
    cancel() {
      cancelled = true
      window.clearInterval(timer)
    }
  }
}

/**
 * Starts a timer-backed percentage simulation.
 *
 * @remarks No input validation is performed. Completion requires a finite,
 * positive `step` that reaches 100; non-positive or `NaN` steps keep the timer
 * alive until cancellation, while `Infinity` reaches 100 on the next tick.
 * Cancellation clears the interval and suppresses later callbacks.
 * @param options - Progress, timing, and callback ownership for the simulation.
 * @returns A controller whose cancellation clears the timer and suppresses later callbacks.
 */
export function createProgressSimulation({
  intervalMs,
  step,
  onProgress,
  onComplete
}: ProgressSimulationOptions): SimulationController {
  let progress = 0
  let cancelled = false
  const timer = window.setInterval(() => {
    if (cancelled) return

    progress = Math.min(100, progress + step)
    onProgress(progress)
    if (cancelled) return

    if (progress === 100) {
      window.clearInterval(timer)
      onComplete()
    }
  }, intervalMs)

  return {
    /** Stops the interval and prevents any later progress or completion callback. */
    cancel() {
      cancelled = true
      window.clearInterval(timer)
    }
  }
}

/**
 * Selects a deterministic demonstration reply using case-insensitive keywords.
 *
 * @param prompt - User text to classify; it is not persisted or sent externally.
 * @returns The matching canned reply, falling back to the generic reply.
 */
export function replyForPrompt(prompt: string): string {
  const value = prompt.toLowerCase()

  if (/what are you|who are you|yourself/.test(value)) return REPLIES.identity
  if (/\bstop\b|cancel|abort|interrupt/.test(value)) return REPLIES.stop
  if (/stream|sse|pipeline|lm studio|architect/.test(value))
    return REPLIES.pipeline
  if (/context|trim|window|token/.test(value)) return REPLIES.context

  return REPLIES.generic
}
