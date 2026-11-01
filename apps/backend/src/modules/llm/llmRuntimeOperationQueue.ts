import { createLlmServiceBusyError } from "./llmServiceBusyError"

/** Admission lifecycle of the queue: open, then closed once for cleanup. */
export type LlmRuntimeOperationQueueStatus = "ready" | "closing" | "closed"

/** Admission lifecycle that refuses new work after cleanup begins. */
type LlmRuntimeOperationQueueState =
  | Readonly<{
      /** The queue accepts work within its capacity. */
      status: "ready"
    }>
  | Readonly<{
      /** Cleanup waits for accepted work, then releases the owner's resources. */
      status: "closing"
      /** Shared cleanup outcome joined by concurrent cleanup calls. */
      completion: Promise<void>
    }>
  | Readonly<{
      /** Cleanup settled; new work is refused. */
      status: "closed"
      /** Settled cleanup outcome reused by repeated cleanup calls. */
      completion: Promise<void>
    }>

/**
 * Work accepted by the queue.
 *
 * @typeParam Result - Result produced by the work.
 */
type LlmRuntimeOperation<Result> = () => Promise<Result>

/** Private admission count and completion tail of the FIFO queue. */
type LlmRuntimeOperationAdmission = {
  /** Completion of every accepted operation, preserving progress after failure. */
  completion: Promise<void>
  /** Accepted operations that have not settled, including the active one. */
  acceptedOperationCount: number
}

/**
 * Inclusive capacity: one active operation and eight waiting operations.
 *
 * @remarks The first operation reserves the active position at admission,
 * before its execution microtask starts. Excess requests are rejected without
 * waiting.
 */
const MAX_ACCEPTED_LLM_RUNTIME_OPERATIONS = 9

/** Stable failure text for work requested after cleanup begins. */
const CLOSED_LLM_RUNTIME_MESSAGE = "The LLM runtime is closed."

/**
 * Owns the admission count, completion tail, and lifecycle of the LLM runtime
 * service's work to run it one operation at a time in admission order, while
 * refusing work beyond capacity and after cleanup begins.
 *
 * @remarks One operation is active and at most eight wait; an operation
 * starts only after every earlier accepted one settles, whatever its outcome.
 * Lifecycle: `ready -> closing -> closed`. Cleanup is terminal and
 * idempotent: it closes admission, waits for accepted work, then calls the
 * release it was given once. No completion deadline is enforced; an
 * operation that never settles keeps later work and cleanup pending.
 * Concurrency model: serialized.
 */
export default class LlmRuntimeOperationQueue {
  /** Exclusively owned admission accounting and completion tail. */
  readonly #admission: LlmRuntimeOperationAdmission = {
    completion: Promise.resolve(),
    acceptedOperationCount: 0
  }

  /** Authoritative lifecycle state controlling admission and cleanup. */
  #state: LlmRuntimeOperationQueueState = Object.freeze({ status: "ready" })

  /**
   * Whether the queue still accepts work.
   *
   * @returns `ready` until cleanup begins, `closing` while it waits and
   * releases, then `closed`. A synchronous in-memory read.
   */
  public get status(): LlmRuntimeOperationQueueStatus {
    return this.#state.status
  }

  /**
   * Adds one operation to the queue and runs it after earlier accepted work.
   *
   * @typeParam Result - Result produced by the operation.
   * @param operation - Deferred work; started only after admission and after
   * every earlier accepted operation settles.
   * @returns The operation's result.
   * @throws `The LLM runtime is closed.` after cleanup begins, or a
   * service-busy error recognized by
   * [isLlmServiceBusyError](./llmServiceBusyError.ts) when one operation is
   * active and eight wait; the operation is not started. Otherwise the
   * operation's own failure.
   * @remarks Admission reserves capacity synchronously. Completion releases
   * it on success or failure before the caller observes the outcome.
   */
  public handleLlmRuntimeOperationRequest<Result>(
    operation: LlmRuntimeOperation<Result>
  ): Promise<Result> {
    if (this.#state.status !== "ready") {
      return Promise.reject(new Error(CLOSED_LLM_RUNTIME_MESSAGE))
    }
    if (
      this.#admission.acceptedOperationCount >=
      MAX_ACCEPTED_LLM_RUNTIME_OPERATIONS
    ) {
      return Promise.reject(createLlmServiceBusyError())
    }

    this.#admission.acceptedOperationCount += 1
    const operationResult = this.#admission.completion.then(
      async () => await this.#handleAcceptedLlmRuntimeOperation(operation)
    )
    this.#admission.completion = operationResult.then(
      () => undefined,
      () => undefined
    )
    return operationResult
  }

  /**
   * Closes admission, waits for every accepted operation, and calls the
   * release once.
   *
   * @param releaseResources - Releases what the queue's owner holds; called
   * at most once, after accepted work settles.
   * @returns The shared cleanup outcome. Concurrent and repeated callers
   * observe the same outcome, and a later caller's release is never called.
   * @throws The release failure, which is terminal and never retried; the
   * queue stays closed.
   */
  public async close(releaseResources: () => Promise<void>): Promise<void> {
    if (this.#state.status !== "ready") {
      await this.#state.completion
      return
    }

    const cleanupCompletion = this.#admission.completion.then(releaseResources)
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
   * Completes one accepted operation and releases its reserved capacity.
   *
   * @typeParam Result - Result produced by the operation.
   * @param operation - Accepted work whose predecessors have settled.
   * @returns The operation result after its capacity is released.
   * @throws The operation failure after its capacity is released.
   */
  async #handleAcceptedLlmRuntimeOperation<Result>(
    operation: LlmRuntimeOperation<Result>
  ): Promise<Result> {
    try {
      return await operation()
    } finally {
      this.#admission.acceptedOperationCount -= 1
    }
  }
}
