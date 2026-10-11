import type {
  BackendToolCallAnswer,
  ChatGenerationEvent,
  ChatToolAnswer,
  ChatToolCall,
  ChatToolResult
} from "@lys/protocol"

/** What resolving one call with an answer did. */
export type ToolCallAnswerOutcome = "accepted" | "not-pending" | "mismatched"

/** One tool call a reply waits on, with the settlement of that wait. */
type PendingToolCall =
  | Readonly<{
      /** The client runs the tool and answers with its result. */
      runner: "client"
      /** Call sent to the reply's followers. */
      toolCall: ChatToolCall
      /** Settles with the client's result, or with undefined once cancelled. */
      answer: PromiseWithResolvers<ChatToolResult | undefined>
    }>
  | Readonly<{
      /** The backend runs the tool once the client allows it. */
      runner: "backend"
      /** Call sent to the reply's followers. */
      toolCall: ChatToolCall
      /** Settles with the client's answer, or with undefined once cancelled. */
      answer: PromiseWithResolvers<BackendToolCallAnswer | undefined>
    }>

/** Whether one reply's calls may still wait, and the calls that do. */
type ToolCallWaitState =
  | Readonly<{
      /** Calls may wait; each waits until it is answered or cancelled. */
      status: "open"
      /** Waiting calls by identifier, in send order; owned by this state. */
      toolCalls: Map<string, PendingToolCall>
    }>
  | Readonly<{
      /** Every wait ended without an answer, and no call may wait again. */
      status: "cancelled"
    }>

/** Waiting calls of a reply that has none. */
const NO_TOOL_CALLS: readonly ChatToolCall[] = Object.freeze([])

/**
 * Owns the tool calls one reply waits on to resume the reply with each call's
 * answer exactly once, while listing every waiting call for followers that
 * start late.
 *
 * @remarks The invariant is that a call is listed from the step that sends it
 * until it is answered with an answer that fits it, or cancelled, and its
 * wait settles exactly once. A call of a client tool fits a result; a call
 * of a backend tool fits `allowed` or `failed`. There is no timer: only an
 * answer or {@link PendingToolCalls.cancelToolCalls} ends a wait. Cancelling
 * is final. Concurrency model: single-owner, on the backend's event loop;
 * every operation is synchronous.
 */
export default class PendingToolCalls {
  /** Authoritative wait state, replaced only by cancellation. */
  #state: ToolCallWaitState = { status: "open", toolCalls: new Map() }

  /**
   * Lists every waiting call.
   *
   * @returns A frozen list in send order; empty when no call waits.
   */
  public get toolCalls(): readonly ChatToolCall[] {
    if (this.#state.status === "cancelled") return NO_TOOL_CALLS
    return Object.freeze(
      [...this.#state.toolCalls.values()].map(({ toolCall }) => toolCall)
    )
  }

  /**
   * Lists one call of a client tool and sends it to the reply's followers in
   * the same synchronous step, then waits for its result.
   *
   * @param toolCall - Checked call whose identifier no waiting call has.
   * @param sendEvent - Queues the call's `tool-call` event for every follower;
   * never waits or throws.
   * @returns A promise resolving with the client's result, or with undefined
   * once the calls are cancelled, at once when they already were. It never
   * rejects.
   * @throws If a call with the same identifier is already waiting; nothing is
   * listed or sent.
   */
  public sendClientToolCall(
    toolCall: ChatToolCall,
    sendEvent: (event: ChatGenerationEvent) => void
  ): Promise<ChatToolResult | undefined> {
    const answer = Promise.withResolvers<ChatToolResult | undefined>()
    const isListed = this.#addToolCall(
      { runner: "client", toolCall, answer },
      sendEvent
    )
    return isListed ? answer.promise : Promise.resolve(undefined)
  }

  /**
   * Lists one call of a backend tool and sends it to the reply's followers in
   * the same synchronous step, then waits for the client to allow it or
   * answer it as failed.
   *
   * @param toolCall - Checked call whose identifier no waiting call has.
   * @param sendEvent - Queues the call's `tool-call` event for every follower;
   * never waits or throws.
   * @returns A promise resolving with the client's answer, or with undefined
   * once the calls are cancelled, at once when they already were. It never
   * rejects.
   * @throws If a call with the same identifier is already waiting; nothing is
   * listed or sent.
   */
  public sendBuiltInToolCall(
    toolCall: ChatToolCall,
    sendEvent: (event: ChatGenerationEvent) => void
  ): Promise<BackendToolCallAnswer | undefined> {
    const answer = Promise.withResolvers<BackendToolCallAnswer | undefined>()
    const isListed = this.#addToolCall(
      { runner: "backend", toolCall, answer },
      sendEvent
    )
    return isListed ? answer.promise : Promise.resolve(undefined)
  }

  /**
   * Ends one call's wait with the client's answer when the answer fits it.
   *
   * @param toolCallId - Identifier of the call's `tool-call` event.
   * @param answer - Validated answer, handed to the waiting reply unchanged.
   * @returns `accepted` when the call was waiting and resumes;
   * `not-pending` when it is unknown, already answered, or cancelled; and
   * `mismatched` when the answer does not fit the call, such as `allowed`
   * for a client tool. Only `accepted` changes anything.
   */
  public resolveToolCall(
    toolCallId: string,
    answer: ChatToolAnswer
  ): ToolCallAnswerOutcome {
    if (this.#state.status === "cancelled") return "not-pending"
    const pendingToolCall = this.#state.toolCalls.get(toolCallId)
    if (pendingToolCall === undefined) return "not-pending"
    switch (pendingToolCall.runner) {
      case "client":
        if (answer.status === "allowed") return "mismatched"
        this.#state.toolCalls.delete(toolCallId)
        pendingToolCall.answer.resolve(answer)
        return "accepted"
      case "backend":
        if (answer.status === "succeeded") return "mismatched"
        this.#state.toolCalls.delete(toolCallId)
        pendingToolCall.answer.resolve(answer)
        return "accepted"
    }
  }

  /**
   * Ends every wait without an answer and refuses later calls.
   *
   * @remarks Idempotent. Each waiting call's promise resolves with undefined,
   * and the list becomes empty.
   */
  public cancelToolCalls(): void {
    if (this.#state.status === "cancelled") return
    const { toolCalls } = this.#state
    this.#state = { status: "cancelled" }
    for (const { answer } of toolCalls.values()) answer.resolve(undefined)
  }

  /**
   * Lists one call and sends its event in the same synchronous step.
   *
   * @param pendingToolCall - Call with its runner and unsettled wait.
   * @param sendEvent - Queues the call's `tool-call` event for every follower.
   * @returns True when the call was listed and sent; false when the calls
   * were cancelled, in which case nothing is listed or sent.
   * @throws If a call with the same identifier is already waiting; nothing is
   * listed or sent.
   */
  #addToolCall(
    pendingToolCall: PendingToolCall,
    sendEvent: (event: ChatGenerationEvent) => void
  ): boolean {
    if (this.#state.status === "cancelled") return false
    const { toolCall } = pendingToolCall
    if (this.#state.toolCalls.has(toolCall.id))
      throw new Error("A tool call with this identifier is already waiting")
    this.#state.toolCalls.set(toolCall.id, pendingToolCall)
    sendEvent({ type: "tool-call", call: toolCall })
    return true
  }
}
