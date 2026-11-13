/**
 * Who asked a reply to stop: `delegator` for the agent that gave the reply's
 * job its work, `person` for the person.
 */
export type StopRequester = "delegator" | "person"

/**
 * Owns the stop requests of replies to answer, when a reply ends, who asked
 * it to stop, while the first requester of a reply stays its requester.
 *
 * @remarks The invariant is that a reply has at most one request, which
 * names whoever asked first since the reply's request was last removed. A
 * later request for the same reply changes nothing, so a reply the
 * delegator asked to stop stays the delegator's when the person asks too,
 * and the other way round.
 *
 * Lifetime: a request is kept in memory until it is removed, and only
 * `removeStopRequest` forgets one. Whoever adds a request for a reply
 * removes it when that reply ends, so the requests held never outnumber the
 * replies asked to stop that have not ended. Nothing is stored: a restart
 * forgets every request.
 *
 * Concurrency model: single-owner, on the backend's event loop. Every
 * operation is synchronous.
 */
export default class ReplyStopRequests {
  /** Requester of each reply asked to stop, by the reply's identity. */
  readonly #requesters = new Map<string, StopRequester>()

  /**
   * Remembers who asked a reply to stop.
   *
   * @param assistantMessageId - UUIDv7 of the reply.
   * @param requester - Who asked.
   * @remarks The first requester of a reply stays: while the reply has a
   * request, this call changes nothing.
   */
  public addStopRequest(
    assistantMessageId: string,
    requester: StopRequester
  ): void {
    if (this.#requesters.has(assistantMessageId)) return
    this.#requesters.set(assistantMessageId, requester)
  }

  /**
   * Forgets the reply's request and answers who made it.
   *
   * @param assistantMessageId - UUIDv7 of the reply.
   * @returns The reply's requester, or undefined when the reply has no
   * request: nobody asked it to stop, or its request was already removed.
   */
  public removeStopRequest(
    assistantMessageId: string
  ): StopRequester | undefined {
    const requester = this.#requesters.get(assistantMessageId)
    this.#requesters.delete(assistantMessageId)
    return requester
  }
}
