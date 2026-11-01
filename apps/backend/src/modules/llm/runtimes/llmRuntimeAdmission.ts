/** Admission and cleanup state owned exclusively by one runtime. */
type LlmRuntimeAdmissionState =
  | Readonly<{
      /** No active operation; model work may begin. */
      status: "ready"
    }>
  | Readonly<{
      /** One accepted operation retains the runtime's resources until settlement. */
      status: "active"
      /** Non-rejecting settlement joined by cleanup regardless of operation outcome. */
      completion: Promise<void>
    }>
  | Readonly<{
      /** Admission is terminally closed while work and cleanup settle. */
      status: "closing"
      /** Shared cleanup outcome retained for every disposal caller. */
      completion: Promise<void>
    }>
  | Readonly<{
      /** Cleanup settled successfully or failed; operations remain forbidden. */
      status: "closed"
      /** Settled cleanup outcome retained without retrying resource release. */
      completion: Promise<void>
    }>

/**
 * Admits one operation at a time to an LLM runtime and closes it once.
 *
 * @remarks Implements the admission and disposal parts of the
 * `LlmRuntimeLifecycle` contract for a runtime that owns it: an
 * operation that overlaps the active one rejects with `The LLM runtime
 * already has an active operation.`, and work after cleanup begins rejects
 * with `The LLM runtime is closed.`, both before the operation starts. There
 * is no waiting queue. State transitions are `ready -> active -> ready` and
 * `ready | active -> closing -> closed`. Concurrency model: single-owner, on
 * the backend's event loop; the owning runtime confines calls.
 */
export default class LlmRuntimeAdmission {
  /** Authoritative operational admission and terminal cleanup state. */
  #state: LlmRuntimeAdmissionState = Object.freeze({ status: "ready" })

  /**
   * Runs one operation in the runtime's sole operation position.
   *
   * @typeParam Result - Result produced by the operation.
   * @param operation - Work that uses the runtime's resources; started only
   * after admission.
   * @returns The operation's result once it settles.
   * @throws `The LLM runtime is closed.` after cleanup begins, or `The LLM
   * runtime already has an active operation.` while another runs; the
   * operation is not started. Otherwise the operation's own failure.
   * @remarks The position is released when the operation settles, unless
   * cleanup began meanwhile, which keeps admission closed.
   */
  public async runOperation<Result>(
    operation: () => Promise<Result>
  ): Promise<Result> {
    const admission = this.#startOperation()
    try {
      return await operation()
    } finally {
      this.#finishOperation(admission)
    }
  }

  /**
   * Closes admission, waits for the active operation, and releases the
   * runtime's resources once.
   *
   * @param releaseResources - Releases what the runtime owns; called at most
   * once, after the active operation settles.
   * @returns The shared cleanup outcome. Concurrent and repeated callers
   * observe the same outcome, and a later caller's release is never called.
   * @throws The release failure, which is terminal and never retried.
   */
  public async close(releaseResources: () => Promise<void>): Promise<void> {
    if (this.#state.status === "closing" || this.#state.status === "closed") {
      return await this.#state.completion
    }
    const activeCompletion =
      this.#state.status === "active"
        ? this.#state.completion
        : Promise.resolve()
    const cleanupCompletion = activeCompletion.then(releaseResources)
    this.#state = Object.freeze({
      status: "closing",
      completion: cleanupCompletion
    })
    try {
      await cleanupCompletion
    } finally {
      this.#state = Object.freeze({
        status: "closed",
        completion: cleanupCompletion
      })
    }
  }

  /**
   * Reserves the sole operation position before any runtime effect.
   *
   * @returns Settlement authority retained by the accepted operation's finalizer.
   * @throws The closed or active-operation failure.
   */
  #startOperation(): PromiseWithResolvers<void> {
    if (this.#state.status === "closing" || this.#state.status === "closed") {
      throw new Error("The LLM runtime is closed.")
    }
    if (this.#state.status === "active") {
      throw new Error("The LLM runtime already has an active operation.")
    }
    const admission = Promise.withResolvers<void>()
    this.#state = Object.freeze({
      status: "active",
      completion: admission.promise
    })
    return admission
  }

  /**
   * Ends the accepted operation while preserving a concurrent terminal
   * cleanup transition.
   *
   * @param admission - Settlement authority of the active operation.
   */
  #finishOperation(admission: PromiseWithResolvers<void>): void {
    if (this.#state.status === "active") {
      this.#state = Object.freeze({ status: "ready" })
    }
    admission.resolve()
  }
}
