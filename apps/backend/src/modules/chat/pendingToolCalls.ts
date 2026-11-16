import { randomBytes, timingSafeEqual } from "node:crypto"
import {
  TOOL_APPROVAL_PROMPT_TIME_LIMIT_MINUTES,
  type ChatGenerationEvent,
  type ChatToolApprovalAnswer,
  type ChatToolApprovalApiRequestBody,
  type ChatToolApprovalPrompt,
  type ChatToolCall,
  type ChatToolResult
} from "@lys/protocol"
import type { ToolApprovalPromptOutcome } from "../toolApproval/toolCallGate"

/**
 * Answer a client gives to one waiting call: a client tool's result, or the
 * person's answer to an approval prompt with the prompt's token.
 */
export type ToolCallAnswer = ChatToolResult | ChatToolApprovalApiRequestBody

/**
 * What resolving one call with an answer did: `accepted` when a call waited
 * for that kind of answer under the identifier and resumes;
 * `token-mismatch` when a prompt waits under the identifier but the answer
 * carries another token; `not-pending` otherwise. Only `accepted` changes
 * anything.
 */
export type ToolCallAnswerOutcome =
  "accepted" | "not-pending" | "token-mismatch"

/** Calls one reply waits on, at one point in time. */
export type PendingToolCallSnapshot = Readonly<{
  /** Calls of client tools sent to run and waiting for their result, in send order. */
  toolCalls: readonly ChatToolCall[]
  /**
   * Prompts shown to the person and waiting for their answer, each with its
   * token, in send order.
   */
  toolApprovals: readonly ChatToolApprovalPrompt[]
}>

/** Random bytes in one approval token: 256 bits, 43 base64url characters. */
const APPROVAL_TOKEN_BYTE_COUNT = 32

/** Milliseconds in one minute. */
const MILLISECONDS_PER_MINUTE = 60_000

/**
 * Milliseconds a prompt waits for the person's answer; at this delay after
 * it was sent, it expires.
 */
const TOOL_APPROVAL_PROMPT_TIME_LIMIT_MS =
  TOOL_APPROVAL_PROMPT_TIME_LIMIT_MINUTES * MILLISECONDS_PER_MINUTE

/** Outcome of a prompt that reached its time limit; carries no per-call data. */
const EXPIRED_TOOL_APPROVAL: ToolApprovalPromptOutcome = Object.freeze({
  status: "expired"
})

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
      /**
       * Single-use token an answer must carry; kept only here, never written
       * to the database or the log.
       */
      approvalToken: string
      /**
       * Settles with the person's answer, with `expired` at the time limit,
       * or with undefined once cancelled.
       */
      answer: PromiseWithResolvers<ToolApprovalPromptOutcome | undefined>
      /**
       * Ends the prompt at its time limit; owned by this listed prompt and
       * cleared as soon as it stops waiting for another reason.
       */
      expiryTimer: ReturnType<typeof setTimeout>
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

/** Snapshot of a reply whose waits ended. */
const NO_PENDING_TOOL_CALLS: PendingToolCallSnapshot = Object.freeze({
  toolCalls: Object.freeze([]),
  toolApprovals: Object.freeze([])
})

/**
 * Owns the tool calls one reply waits on to resume the reply with each call's
 * answer exactly once, while listing every waiting call for followers that
 * start late.
 *
 * @remarks The invariant is that a call is listed from the step that sends it
 * until it is answered with an answer that fits it, or cancelled, and its
 * wait settles exactly once. A call sent to run fits a client tool's result;
 * a call shown for approval fits the person's answer with the token its
 * prompt carried, which binds the answer to that prompt: the call that
 * resumes is the one listed with the token, and the token stops working once
 * an answer is accepted or the wait ends. A call identifier waits
 * for at most one answer at a time: a client tool's prompt is answered before
 * the same call is sent to run. A prompt also ends at its time limit: its
 * timer, owned by the listed prompt and cleared as soon as the prompt stops
 * waiting for another reason, removes it and settles its wait with
 * `expired`, so its token is refused from then on. A call sent to run has no
 * time limit: only its result or {@link PendingToolCalls.cancelToolCalls}
 * ends its wait. Cancelling is final and clears every timer.
 * Concurrency model: single-owner, on the backend's event loop; every
 * operation, the timer's included, is synchronous.
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
    const toolCalls: ChatToolCall[] = []
    const toolApprovals: ChatToolApprovalPrompt[] = []
    for (const pendingToolCall of this.#state.toolCalls.values()) {
      switch (pendingToolCall.kind) {
        case "run":
          toolCalls.push(pendingToolCall.toolCall)
          break
        case "approval":
          toolApprovals.push(
            Object.freeze({
              call: pendingToolCall.toolCall,
              approvalToken: pendingToolCall.approvalToken
            })
          )
          break
      }
    }
    return Object.freeze({
      toolCalls: Object.freeze(toolCalls),
      toolApprovals: Object.freeze(toolApprovals)
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
    const toolCalls = this.#findWaitingToolCalls(toolCall.id)
    if (toolCalls === undefined) return Promise.resolve(undefined)
    const answer = Promise.withResolvers<ChatToolResult | undefined>()
    toolCalls.set(toolCall.id, { kind: "run", toolCall, answer })
    sendEvent({ type: "tool-call", call: toolCall })
    return answer.promise
  }

  /**
   * Lists one call with a new single-use token and shows both to the reply's
   * followers for approval in the same synchronous step, then waits for the
   * person's answer until the prompt's time limit.
   *
   * @param toolCall - Checked call whose identifier no waiting call has.
   * @param sendEvent - Queues the call's `tool-approval` event for every
   * follower; never waits or throws.
   * @returns A promise resolving with the person's answer when it arrives
   * before the time limit; with `expired` at the limit, once the prompt is
   * removed and its token refused; or with undefined once the calls are
   * cancelled, at once when they already were. It never rejects.
   * @throws If a call with the same identifier is already waiting; nothing is
   * listed or sent, and no timer starts.
   */
  public sendToolApprovalPrompt(
    toolCall: ChatToolCall,
    sendEvent: (event: ChatGenerationEvent) => void
  ): Promise<ToolApprovalPromptOutcome | undefined> {
    const toolCalls = this.#findWaitingToolCalls(toolCall.id)
    if (toolCalls === undefined) return Promise.resolve(undefined)
    const answer = Promise.withResolvers<
      ToolApprovalPromptOutcome | undefined
    >()
    const approvalToken = randomBytes(APPROVAL_TOKEN_BYTE_COUNT).toString(
      "base64url"
    )
    const expiryTimer = setTimeout(() => {
      this.#expireToolApproval(toolCall.id, approvalToken)
    }, TOOL_APPROVAL_PROMPT_TIME_LIMIT_MS)
    toolCalls.set(toolCall.id, {
      kind: "approval",
      toolCall,
      approvalToken,
      answer,
      expiryTimer
    })
    sendEvent({ type: "tool-approval", call: toolCall, approvalToken })
    return answer.promise
  }

  /**
   * Ends one call's wait with a client's answer when the call waits for that
   * kind of answer.
   *
   * @param toolCallId - Identifier of the call's event.
   * @param answer - Validated answer: a result for a call sent to run,
   * handed to the waiting reply unchanged; the person's answer and the
   * prompt's token for a call shown for approval, handed on without the
   * token.
   * @returns `accepted` when the call was waiting for that kind of answer,
   * with that token for a prompt before its time limit, and resumes;
   * `token-mismatch` when a prompt waits under the identifier but the token
   * is another; `not-pending` when the call is unknown, already answered,
   * expired, cancelled, or waiting for the other kind of answer. Only
   * `accepted` changes anything, and it clears an accepted prompt's timer; a
   * prompt keeps waiting after a `token-mismatch`.
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
        if (
          !isSameApprovalToken(
            pendingToolCall.approvalToken,
            answer.approvalToken
          )
        )
          return "token-mismatch"
        clearTimeout(pendingToolCall.expiryTimer)
        this.#state.toolCalls.delete(toolCallId)
        pendingToolCall.answer.resolve(readToolApprovalAnswer(answer))
        return "accepted"
    }
  }

  /**
   * Ends every wait without an answer and refuses later calls.
   *
   * @remarks Idempotent. Each prompt's timer is cleared, each waiting call's
   * promise resolves with undefined, and both lists become empty.
   */
  public cancelToolCalls(): void {
    if (this.#state.status === "cancelled") return
    const { toolCalls } = this.#state
    this.#state = { status: "cancelled" }
    for (const pendingToolCall of toolCalls.values()) {
      if (pendingToolCall.kind === "approval")
        clearTimeout(pendingToolCall.expiryTimer)
      pendingToolCall.answer.resolve(undefined)
    }
  }

  /**
   * Finds the waiting calls a new call joins.
   *
   * @param toolCallId - Identifier of the new call.
   * @returns The waiting calls, owned by the open state; undefined once the
   * calls are cancelled.
   * @throws If a call with the same identifier is already waiting.
   */
  #findWaitingToolCalls(
    toolCallId: string
  ): Map<string, PendingToolCall> | undefined {
    if (this.#state.status === "cancelled") return undefined
    if (this.#state.toolCalls.has(toolCallId))
      throw new Error("A tool call with this identifier is already waiting")
    return this.#state.toolCalls
  }

  /**
   * Ends one prompt that reached its time limit without an answer.
   *
   * @param toolCallId - Identifier of the prompted call.
   * @param approvalToken - Token the prompt was sent with.
   * @remarks Run only by the prompt's own timer, which is cleared as soon as
   * the prompt stops waiting for another reason; the token check keeps a
   * late run from ending anything but the prompt that started it. The prompt
   * is removed, so its token is refused from then on, and its wait settles
   * with `expired`.
   */
  #expireToolApproval(toolCallId: string, approvalToken: string): void {
    if (this.#state.status === "cancelled") return
    const pendingToolCall = this.#state.toolCalls.get(toolCallId)
    if (
      pendingToolCall?.kind !== "approval" ||
      pendingToolCall.approvalToken !== approvalToken
    )
      return
    this.#state.toolCalls.delete(toolCallId)
    pendingToolCall.answer.resolve(EXPIRED_TOOL_APPROVAL)
  }
}

/**
 * Answers whether an answer is the person's answer to an approval prompt.
 *
 * @param answer - Validated answer.
 * @returns True for `allowed` and `rejected`; false for a tool's result.
 */
function isToolApprovalAnswer(
  answer: ToolCallAnswer
): answer is ChatToolApprovalApiRequestBody {
  return answer.status === "allowed" || answer.status === "rejected"
}

/**
 * Compares a prompt's token with the token an answer carries, in time that
 * does not depend on how much of the answer's token matches.
 *
 * @param approvalToken - Token the prompt was sent with.
 * @param answeredToken - Validated token the answer carries.
 * @returns True only when both are the same text.
 */
function isSameApprovalToken(
  approvalToken: string,
  answeredToken: string
): boolean {
  const expected = Buffer.from(approvalToken)
  const answered = Buffer.from(answeredToken)
  return (
    expected.length === answered.length && timingSafeEqual(expected, answered)
  )
}

/**
 * Reads the person's answer out of a tool-approval body, leaving its token
 * behind so it never reaches the reply.
 *
 * @param body - Validated body whose token matched its prompt.
 * @returns A frozen answer with the body's status, and for a rejection its
 * reason and content.
 */
function readToolApprovalAnswer(
  body: ChatToolApprovalApiRequestBody
): ChatToolApprovalAnswer {
  switch (body.status) {
    case "allowed":
      return Object.freeze({ status: "allowed" })
    case "rejected":
      return Object.freeze({
        status: "rejected",
        reason: body.reason,
        content: body.content
      })
  }
}
