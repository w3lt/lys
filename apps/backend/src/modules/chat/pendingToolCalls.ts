import type {
  ChatGenerationEvent,
  ChatToolApprovalAnswer,
  ChatToolCall,
  ChatToolResult
} from "@lys/protocol"

/**
 * Answer a client gives to one waiting call: a client tool's result, or the
 * person's answer to an approval prompt.
 */
export type ToolCallAnswer = ChatToolResult | ChatToolApprovalAnswer

/**
 * What resolving one call with an answer did: `accepted` when a call waited
 * for that kind of answer under the identifier and resumes; `not-pending`
 * otherwise, which changes nothing.
 */
export type ToolCallAnswerOutcome = "accepted" | "not-pending"

/** Calls one reply waits on, at one point in time. */
export type PendingToolCallSnapshot = Readonly<{
  /** Calls of client tools sent to run and waiting for their result, in send order. */
  toolCalls: readonly ChatToolCall[]
  /** Calls shown to the person and waiting for their answer, in send order. */
  toolApprovals: readonly ChatToolCall[]
}>

/** One call a reply waits on, with the settlement of that wait. */
type PendingToolCall =
  | Readonly<{
      /** The client runs the call and answers with its result. */
      kind: "run"
      /** Call sent to the reply's followers. */
      toolCall: ChatToolCall
      /** Settles with the client's result, or with undefined once cancelled. */
      answer: PromiseWithResolvers<ChatToolResult | undefined>
    }>
  | Readonly<{
      /** The person allows or rejects the call before anything runs. */
      kind: "approval"
      /** Call shown to the reply's followers. */
      toolCall: ChatToolCall
      /** Settles with the person's answer, or with undefined once cancelled. */
      answer: PromiseWithResolvers<ChatToolApprovalAnswer | undefined>
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

/** Snapshot of a reply whose waits ended. */
const NO_PENDING_TOOL_CALLS: PendingToolCallSnapshot = Object.freeze({
  toolCalls: NO_TOOL_CALLS,
  toolApprovals: NO_TOOL_CALLS
})

/**
 * Owns the tool calls one reply waits on to resume the reply with each call's
 * answer exactly once, while listing every waiting call for followers that
 * start late.
 *
 * @remarks The invariant is that a call is listed from the step that sends it
 * until it is answered with an answer that fits it, or cancelled, and its
 * wait settles exactly once. A call sent to run fits a client tool's result;
 * a call shown for approval fits the person's answer. A call identifier waits
 * for at most one answer at a time: a client tool's prompt is answered before
 * the same call is sent to run. There is no timer: only an answer or
 * {@link PendingToolCalls.cancelToolCalls} ends a wait. Cancelling is final.
 * Concurrency model: single-owner, on the backend's event loop; every
 * operation is synchronous.
 */
export default class PendingToolCalls {
  /** Authoritative wait state, replaced only by cancellation. */
  #state: ToolCallWaitState = { status: "open", toolCalls: new Map() }

  /**
   * Lists every waiting call.
   *
   * @returns A frozen snapshot of the calls waiting for a result and the
   * calls waiting for approval, each list in send order; both empty when no
   * call waits.
   */
  public get snapshot(): PendingToolCallSnapshot {
    if (this.#state.status === "cancelled") return NO_PENDING_TOOL_CALLS
    const pendingToolCalls = [...this.#state.toolCalls.values()]
    return Object.freeze({
      toolCalls: listToolCallsOfKind(pendingToolCalls, "run"),
      toolApprovals: listToolCallsOfKind(pendingToolCalls, "approval")
    })
  }

  /**
   * Lists one call of a client tool and sends it to the reply's followers to
   * run in the same synchronous step, then waits for its result.
   *
   * @param toolCall - Checked call that may run, whose identifier no waiting
   * call has.
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
      { kind: "run", toolCall, answer },
      () => {
        sendEvent({ type: "tool-call", call: toolCall })
      }
    )
    return isListed ? answer.promise : Promise.resolve(undefined)
  }

  /**
   * Lists one call and shows it to the reply's followers for approval in the
   * same synchronous step, then waits for the person's answer.
   *
   * @param toolCall - Checked call whose identifier no waiting call has.
   * @param sendEvent - Queues the call's `tool-approval` event for every
   * follower; never waits or throws.
   * @returns A promise resolving with the person's answer, or with undefined
   * once the calls are cancelled, at once when they already were. It never
   * rejects.
   * @throws If a call with the same identifier is already waiting; nothing is
   * listed or sent.
   */
  public sendToolApprovalPrompt(
    toolCall: ChatToolCall,
    sendEvent: (event: ChatGenerationEvent) => void
  ): Promise<ChatToolApprovalAnswer | undefined> {
    const answer = Promise.withResolvers<ChatToolApprovalAnswer | undefined>()
    const isListed = this.#addToolCall(
      { kind: "approval", toolCall, answer },
      () => {
        sendEvent({ type: "tool-approval", call: toolCall })
      }
    )
    return isListed ? answer.promise : Promise.resolve(undefined)
  }

  /**
   * Ends one call's wait with a client's answer when the call waits for that
   * kind of answer.
   *
   * @param toolCallId - Identifier of the call's event.
   * @param answer - Validated answer, handed to the waiting reply unchanged:
   * a result for a call sent to run, the person's answer for a call shown for
   * approval.
   * @returns `accepted` when the call was waiting for that kind of answer and
   * resumes; `not-pending` when it is unknown, already answered, cancelled,
   * or waiting for the other kind of answer. Only `accepted` changes
   * anything.
   */
  public resolveToolCall(
    toolCallId: string,
    answer: ToolCallAnswer
  ): ToolCallAnswerOutcome {
    if (this.#state.status === "cancelled") return "not-pending"
    const pendingToolCall = this.#state.toolCalls.get(toolCallId)
    if (pendingToolCall === undefined) return "not-pending"
    switch (pendingToolCall.kind) {
      case "run":
        if (isToolApprovalAnswer(answer)) return "not-pending"
        this.#state.toolCalls.delete(toolCallId)
        pendingToolCall.answer.resolve(answer)
        return "accepted"
      case "approval":
        if (!isToolApprovalAnswer(answer)) return "not-pending"
        this.#state.toolCalls.delete(toolCallId)
        pendingToolCall.answer.resolve(answer)
        return "accepted"
    }
  }

  /**
   * Ends every wait without an answer and refuses later calls.
   *
   * @remarks Idempotent. Each waiting call's promise resolves with undefined,
   * and both lists become empty.
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
   * @param pendingToolCall - Call with its kind and unsettled wait.
   * @param sendToolCallEvent - Queues the call's event for every follower.
   * @returns True when the call was listed and sent; false when the calls
   * were cancelled, in which case nothing is listed or sent.
   * @throws If a call with the same identifier is already waiting; nothing is
   * listed or sent.
   */
  #addToolCall(
    pendingToolCall: PendingToolCall,
    sendToolCallEvent: () => void
  ): boolean {
    if (this.#state.status === "cancelled") return false
    const { toolCall } = pendingToolCall
    if (this.#state.toolCalls.has(toolCall.id))
      throw new Error("A tool call with this identifier is already waiting")
    this.#state.toolCalls.set(toolCall.id, pendingToolCall)
    sendToolCallEvent()
    return true
  }
}

/**
 * Lists the waiting calls of one kind.
 *
 * @param pendingToolCalls - Waiting calls in send order.
 * @param kind - Kind to keep.
 * @returns A frozen list of those calls in send order.
 */
function listToolCallsOfKind(
  pendingToolCalls: readonly PendingToolCall[],
  kind: PendingToolCall["kind"]
): readonly ChatToolCall[] {
  return Object.freeze(
    pendingToolCalls
      .filter((pendingToolCall) => pendingToolCall.kind === kind)
      .map(({ toolCall }) => toolCall)
  )
}

/**
 * Answers whether an answer is the person's answer to an approval prompt.
 *
 * @param answer - Validated answer.
 * @returns True for `allowed` and `rejected`; false for a tool's result.
 */
function isToolApprovalAnswer(
  answer: ToolCallAnswer
): answer is ChatToolApprovalAnswer {
  return answer.status === "allowed" || answer.status === "rejected"
}
