/**
 * Largest number of accepted events a follower may have waiting for delivery.
 *
 * @remarks Inclusive limit, in events. A reply sends about one delta per model
 * token, so this lets a follower lag behind by many seconds of output. A
 * follower that falls further behind is closed instead of retaining unbounded
 * output; its client can follow the reply again and receive a fresh snapshot.
 */
const MAXIMUM_QUEUED_SUBSCRIPTION_EVENTS = 4096

/**
 * Delivers one stream's events to one SSE connection in order, without making
 * the producer wait for that connection.
 *
 * @typeParam TStreamEvent - Event type written to the connection; the
 * producer and the connection's writer agree on it.
 * @remarks Owns the queue of events accepted for one borrowed connection to
 * deliver them in acceptance order while bounding how many wait. The route
 * keeps ownership of the connection itself. Concurrency model: single-owner,
 * on the backend's event loop. `handleStreamEvent` and `close` are
 * synchronous and never wait for a write; writes run one at a time. A failed
 * write, a full queue, or `close` ends the subscription, and `closed` settles
 * after it has ended and every accepted write has settled.
 */
export default class ReplyEventSubscription<TStreamEvent> {
  /** Writes one event to the borrowed connection. */
  readonly #sendEvent: (event: TStreamEvent) => Promise<void>
  /** Settles once the subscription has ended and accepted writes settled. */
  readonly #closure = Promise.withResolvers<void>()
  /** Chain of accepted writes; each starts after the previous one settles. */
  #delivery: Promise<void> = Promise.resolve()
  /** Accepted events whose write has not settled yet. */
  #queuedEventCount = 0
  /** Whether the subscription still accepts events. */
  #isOpen = true

  /**
   * Creates an open subscription with an empty queue.
   *
   * @param sendEvent - Borrowed writer for one SSE connection. It resolves
   * after the transport accepts the event and rejects when the connection has
   * already closed; a write pending when the connection closes may never
   * settle.
   */
  public constructor(sendEvent: (event: TStreamEvent) => Promise<void>) {
    this.#sendEvent = sendEvent
  }

  /**
   * Settlement of the subscription's end.
   *
   * @returns A promise that settles after the subscription stopped accepting
   * events and every accepted write settled; it never rejects, and it stays
   * pending while an accepted write never settles.
   */
  public get closed(): Promise<void> {
    return this.#closure.promise
  }

  /**
   * Accepts one event for delivery after every earlier accepted event.
   *
   * @param event - Immutable event to write.
   * @returns Whether the event was accepted; false once the subscription has
   * ended. An event that would exceed the queue limit ends the subscription
   * and is not accepted.
   */
  public handleStreamEvent(event: TStreamEvent): boolean {
    if (!this.#isOpen) return false
    if (this.#queuedEventCount >= MAXIMUM_QUEUED_SUBSCRIPTION_EVENTS) {
      this.close()
      return false
    }

    this.#queuedEventCount += 1
    this.#delivery = this.#delivery.then(() => this.#handleQueuedEvent(event))
    return true
  }

  /**
   * Stops accepting events; `closed` settles after accepted writes settle.
   *
   * @remarks Idempotent. It does not close the connection; the route that
   * owns the connection ends it once `closed` settles.
   */
  public close(): void {
    if (!this.#isOpen) return

    this.#isOpen = false
    void this.#delivery.then(() => {
      this.#closure.resolve()
    })
  }

  /**
   * Writes one accepted event once every earlier write has settled.
   *
   * @param event - Event accepted by {@link ReplyEventSubscription.handleStreamEvent}.
   * @returns Settlement after the write; it never rejects.
   * @remarks A write fails only once the connection is closed, so no later
   * event can reach this follower; the subscription ends while the producer
   * and other followers continue.
   */
  async #handleQueuedEvent(event: TStreamEvent): Promise<void> {
    try {
      await this.#sendEvent(event)
    } catch {
      this.close()
    } finally {
      this.#queuedEventCount -= 1
    }
  }
}
