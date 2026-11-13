import type { ChatToolApprovalAnswer, ChatToolCall } from "@lys/protocol"
import type { ToolApprovalMode } from "./toolCallDecisionRecord"

/**
 * How one approval prompt ended: the person's answer, or `expired` when the
 * person did not answer within the prompt's time limit, so nobody allowed
 * the call.
 */
export type ToolApprovalPromptOutcome =
  | ChatToolApprovalAnswer
  | Readonly<{
      /** The prompt waited for the time limit without an answer. */
      status: "expired"
    }>

/**
 * Shows one checked call to the person and waits for their answer; resolves
 * with `expired` when the prompt reached its time limit first, or with
 * undefined when the reply was stopped while the prompt waited. It sends the
 * prompt in the same synchronous step and never rejects.
 */
export type SendToolApprovalPrompt = (
  toolCall: ChatToolCall
) => Promise<ToolApprovalPromptOutcome | undefined>

/**
 * Stores one checked call in the state the gate chose for it, `running` when
 * it may run at once, `awaiting-approval` when the person is asked, with the
 * approval mode the gate applied. Answers false when the reply refused to
 * store it, because the reply has ended.
 */
export type StoreStartedToolCall = (
  status: "awaiting-approval" | "running",
  approvalMode: ToolApprovalMode
) => boolean

/** What starting one checked call led to. */
export type ToolCallStart =
  | Readonly<{
      /** The call is stored as running and may run now. */
      status: "allowed"
    }>
  | Readonly<{
      /** The call is stored as awaiting approval, and the person was asked. */
      status: "prompted"
      /**
       * Settles with the person's answer, with `expired` when the prompt
       * reached its time limit first, or with undefined when the reply was
       * stopped while the prompt waited; never rejects.
       */
      answer: Promise<ToolApprovalPromptOutcome | undefined>
    }>
  | Readonly<{
      /** The reply refused to store the call; nobody was asked. */
      status: "ended"
    }>

/** Start of a call that may run at once. */
const ALLOWED_TOOL_CALL_START: ToolCallStart = Object.freeze({
  status: "allowed"
})

/** Start of a call the reply refused to store. */
const ENDED_TOOL_CALL_START: ToolCallStart = Object.freeze({ status: "ended" })

/**
 * Owns the Just run choices read for one model round and the reply's prompt
 * sender to start each checked call of the round: stored as running when it
 * may go on without the person, or stored as awaiting approval and shown to
 * the person.
 *
 * @remarks The invariant is that a call goes on without the person only when
 * its tool's name was saved as Just run when the round's calls arrived and
 * the tool call policy does not require approval of it, and that no prompt is
 * sent for a call that is not stored. The choices never change after
 * construction, so a change saved later applies from the next round.
 * Concurrency model: single-owner, on the backend's event loop, like the
 * reply's waits that the prompt sender borrows.
 */
export default class ToolCallGate {
  /** Names of the tools on Just run for this round; owned, never changed. */
  readonly #justRunToolNames: ReadonlySet<string>
  /** Shows a call to the person; borrowed from the reply. */
  readonly #sendToolApprovalPrompt: SendToolApprovalPrompt

  /**
   * Creates the gate of one round.
   *
   * @param justRunToolNames - Names of the tools saved as Just run; copied,
   * so later changes to the given set do not affect the gate.
   * @param sendToolApprovalPrompt - Prompt sender of the reply the round
   * belongs to, borrowed for the round.
   */
  public constructor(
    justRunToolNames: ReadonlySet<string>,
    sendToolApprovalPrompt: SendToolApprovalPrompt
  ) {
    this.#justRunToolNames = new Set(justRunToolNames)
    this.#sendToolApprovalPrompt = sendToolApprovalPrompt
  }

  /**
   * Starts one checked call: stores it in the state the saved choices give
   * it and, when it may not go on without the person, shows it to them, in
   * one synchronous step.
   *
   * @param toolCall - Checked call of an offered tool the policy did not
   * deny.
   * @param isApprovalRequired - Whether the policy requires the person's
   * approval of the call, whatever they saved for its tool.
   * @param storeToolCall - Stores the call in the state given, with the
   * approval mode applied: `just-run` when the tool was saved as Just run,
   * `ask-me` otherwise; borrowed for this call.
   * @returns `allowed` once the call is stored as running, when its tool was
   * saved as Just run and approval is not required; `prompted` with how
   * the prompt ends once it is stored as awaiting approval and the prompt is
   * sent; `ended` when the store refused the call, which sends no prompt.
   * @remarks The call is stored before its prompt is sent, so a client that
   * sees the prompt can read the call it asks about.
   */
  public startToolCall(
    toolCall: ChatToolCall,
    isApprovalRequired: boolean,
    storeToolCall: StoreStartedToolCall
  ): ToolCallStart {
    const approvalMode: ToolApprovalMode = this.#justRunToolNames.has(
      toolCall.toolName
    )
      ? "just-run"
      : "ask-me"
    const isAllowedAtOnce = !isApprovalRequired && approvalMode === "just-run"
    if (
      !storeToolCall(
        isAllowedAtOnce ? "running" : "awaiting-approval",
        approvalMode
      )
    )
      return ENDED_TOOL_CALL_START
    if (isAllowedAtOnce) return ALLOWED_TOOL_CALL_START
    return Object.freeze({
      status: "prompted",
      answer: this.#sendToolApprovalPrompt(toolCall)
    })
  }
}
