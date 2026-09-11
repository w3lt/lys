import type {
  LlmRuntimeAvailability,
  LlmRuntimeLifecycleStatus
} from "./llmRuntimeTypes"

/**
 * Observes and closes one exclusively owned LLM runtime.
 *
 * @remarks Successful acquisition transfers this lifecycle to one exclusive
 * owner. Implementations admit one operation without a waiting queue. That owner
 * retains every accepted availability query until settlement, independently of
 * the observing caller's lifetime. Disposal closes admission synchronously,
 * awaits active work without a completion deadline, and preserves terminal
 * status after cleanup settles.
 */
export interface LlmRuntimeLifecycle {
  /**
   * Observes the runtime's current admission and cleanup phase synchronously.
   *
   * @returns The authoritative lifecycle phase at the instant of access.
   * @remarks Inspection remains available while ready, active, closing, and closed.
   */
  get lifecycleStatus(): LlmRuntimeLifecycleStatus

  /**
   * Checks whether the attached engine answers a provider readiness query.
   *
   * @returns `available` after a successful provider query or `unavailable`
   * after its expected failure.
   * @throws `The LLM runtime already has an active operation.` when busy, or
   * `The LLM runtime is closed.` after disposal begins.
   * @remarks The query occupies the runtime's sole operation position, is
   * completion-only, and does not guarantee availability for a later operation.
   */
  getRuntimeAvailability(): Promise<LlmRuntimeAvailability>

  /**
   * Ends admission, awaits active work, and releases adapter-owned resources.
   *
   * @returns A promise resolving after accepted work and client cleanup settle.
   * Concurrent and repeated callers observe the same cleanup outcome.
   * @throws `The LLM runtime could not release its resources.` with the original
   * cleanup cause. Failed cleanup is terminal and is never retried.
   * @remarks Cleanup does not unload every model or terminate the external engine.
   */
  [Symbol.asyncDispose](): Promise<void>
}
