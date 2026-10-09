import type {
  ChatGenerationEvent,
  ChatToolCall,
  ChatToolResult
} from "@lys/protocol"

/** One tool call a reply waits on, with the settlement of that wait. */
type PendingToolCall = Readonly<{
  /** Call sent to the reply's followers. */
  toolCall: ChatToolCall
  /** Settles with the client's answer, or with undefined once cancelled. */
  answer: PromiseWithResolvers<ChatToolResult | undefined>
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
 * until it is answered or cancelled, and its wait settles exactly once. There
 * is no timer: only an answer or {@link PendingToolCalls.cancelToolCalls} ends
 * a wait. Cancelling is final. Concurrency model: single-owner, on the
 * backend's event loop; every operation is synchronous.
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
   * Lists one call and sends it to the reply's followers in the same
   * synchronous step, then waits for its answer.
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
  public sendToolCall(
    toolCall: ChatToolCall,
    sendEvent: (event: ChatGenerationEvent) => void
  ): Promise<ChatToolResult | undefined> {
    if (this.#state.status === "cancelled") return Promise.resolve(undefined)
    if (this.#state.toolCalls.has(toolCall.id))
      throw new Error("A tool call with this identifier is already waiting")
    const answer = Promise.withResolvers<ChatToolResult | undefined>()
    this.#state.toolCalls.set(toolCall.id, { toolCall, answer })
    sendEvent({ type: "tool-call", call: toolCall })
    return answer.promise
  }

  /**
   * Ends one call's wait with the client's answer.
   *
   * @param toolCallId - Identifier of the call's `tool-call` event.
   * @param result - Validated answer, handed to the waiting reply unchanged.
   * @returns True when the call was waiting and resumes; false when it is
   * unknown, already answered, or cancelled, which changes nothing.
   */
  public resolveToolCall(toolCallId: string, result: ChatToolResult): boolean {
    if (this.#state.status === "cancelled") return false
    const pendingToolCall = this.#state.toolCalls.get(toolCallId)
    if (pendingToolCall === undefined) return false
    this.#state.toolCalls.delete(toolCallId)
    pendingToolCall.answer.resolve(result)
    return true
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
}
