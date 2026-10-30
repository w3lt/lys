/**
 * Records whether any runtime call of one queued model operation rejected.
 *
 * @remarks Owns one failure flag for the lifetime of a single queued model
 * operation; the flag only changes from unrecorded to recorded. The engine
 * views of that operation route their calls through it, so a rejection from
 * any of them is recorded once. Results and rejections are returned
 * unchanged; a synchronous throw is returned as a rejection. Concurrency
 * model: single-owner; the runtime service creates one record per accepted
 * operation and discards it when that operation settles.
 */
export default class LlmRuntimeCallRecord {
  /** Whether any recorded call has rejected since construction. */
  #hasRecordedFailure = false

  /**
   * Whether any recorded runtime call has rejected.
   *
   * @returns `true` once any call rejected; it never returns to `false`.
   */
  public get hasRecordedFailure(): boolean {
    return this.#hasRecordedFailure
  }

  /**
   * Performs one runtime call and records its rejection.
   *
   * @typeParam Result - Result produced by the call.
   * @param llmRuntimeCall - Deferred call to a borrowed runtime capability.
   * @returns The call's result.
   * @throws The call's original failure, after recording it.
   */
  public async handleLlmRuntimeCall<Result>(
    llmRuntimeCall: () => Promise<Result>
  ): Promise<Result> {
    try {
      return await llmRuntimeCall()
    } catch (error) {
      this.#hasRecordedFailure = true
      throw error
    }
  }
}
