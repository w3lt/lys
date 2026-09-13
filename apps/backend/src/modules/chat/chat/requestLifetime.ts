/**
 * Owns admitted chat handlers until their asynchronous cleanup has settled.
 * @remarks One event-loop owner serializes admission and disposal calls; this is
 * not a cross-thread synchronization primitive. Every admitted operation remains
 * tracked through settlement. Disposal permanently closes admission before
 * yielding, joins the existing tasks, and shares one completion promise across
 * repeated or concurrent calls. Callers observe request failures independently.
 */
export class ChatRequestLifetime implements AsyncDisposable {
  /** Complete handler promises, including terminal persistence after disconnect. */
  readonly #tasks = new Set<Promise<void>>()
  /** Shared disposal completion; its presence permanently closes admission. */
  #disposal: Promise<void> | undefined

  /**
   * Admits and observes one handler through its complete cleanup path.
   * @param operation - Lazy request operation borrowing application services.
   * @returns Handler completion or its original failure.
   * @throws If admission is closed or the request operation fails.
   */
  async createRequestTask(operation: () => Promise<void>): Promise<void> {
    if (this.#disposal !== undefined)
      throw new Error("Chat request lifetime is closed")
    const task = Promise.resolve().then(operation)
    this.#tasks.add(task)
    try {
      await task
    } finally {
      this.#tasks.delete(task)
    }
  }

  /**
   * Closes admission and drains handlers before their borrowed services are disposed.
   * @returns Shared, idempotent completion after all admitted handlers settle.
   * @remarks Request failures remain observable by their callers; draining does not
   * rethrow them into application shutdown. Socket closure alone does not join handlers.
   */
  [Symbol.asyncDispose](): Promise<void> {
    this.#disposal ??= Promise.allSettled([...this.#tasks]).then(
      () => undefined
    )
    return this.#disposal
  }
}
