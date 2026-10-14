import type { ChatToolApprovalAnswer, ChatToolCall } from "@lys/protocol"

/**
 * Shows one checked call to the person and waits for their answer; resolves
 * with undefined when the reply was stopped while the prompt waited. It sends
 * the prompt in the same synchronous step and never rejects.
 */
export type SendToolApprovalPrompt = (
  toolCall: ChatToolCall
) => Promise<ChatToolApprovalAnswer | undefined>

/**
 * What asking the gate about one call did.
 *
 * @remarks `allowed`: the tool is on Just run, nothing was sent, and the call
 * may go on in the same step. `prompted`: the call was shown to the person
 * in the same step, and `answer` settles with their answer.
 */
export type ToolApprovalRequest =
  | Readonly<{
      /** The call may go on without asking the person. */
      status: "allowed"
    }>
  | Readonly<{
      /** The call was shown to the person. */
      status: "prompted"
      /**
       * Resolves with the person's answer, or with undefined when the reply
       * was stopped while the prompt waited; never rejects.
       */
      answer: Promise<ChatToolApprovalAnswer | undefined>
    }>

/** Request outcome of a call whose tool is on Just run. */
const ALLOWED_TOOL_APPROVAL_REQUEST: ToolApprovalRequest = Object.freeze({
  status: "allowed"
})

/**
 * Owns the Just run choices read for one model round and the reply's prompt
 * sender to decide, for each call of the round, whether the person is asked
 * first.
 *
 * @remarks The invariant is that a call goes on without the person only when
 * its tool's name was saved as Just run when the round's calls arrived;
 * every other call waits for the person's answer. The choices never change
 * after construction, so a change saved later applies from the next round.
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
   * Decides whether one checked call may go on, prompting the person when
   * the tool is not on Just run.
   *
   * @param toolCall - Checked call of an offered tool.
   * @returns `allowed` when the tool is on Just run, without sending
   * anything; otherwise `prompted`, after the prompt was sent, with the
   * person's answer to come.
   * @remarks Both outcomes are decided in the same synchronous step, so a
   * caller that goes on with an allowed call at once keeps the order of a
   * round's prompts and run requests.
   */
  public sendToolApprovalRequest(toolCall: ChatToolCall): ToolApprovalRequest {
    if (this.#justRunToolNames.has(toolCall.toolName))
      return ALLOWED_TOOL_APPROVAL_REQUEST
    return Object.freeze({
      status: "prompted",
      answer: this.#sendToolApprovalPrompt(toolCall)
    })
  }
}
