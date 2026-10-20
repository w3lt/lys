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
 * Owns the Just run choices read for one model round and the reply's prompt
 * sender to tell, for each call of the round, whether it may go on without
 * the person, and to ask the person about a call that may not.
 *
 * @remarks The invariant is that a call is allowed at once only when its
 * tool's name was saved as Just run when the round's calls arrived. The
 * choices never change after construction, so a change saved later applies
 * from the next round. The round's caller asks the person about every other
 * call and waits for the answer. Concurrency model: single-owner, on the
 * backend's event loop, like the reply's waits that the prompt sender
 * borrows.
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
   * Answers whether one checked call may go on without asking the person.
   *
   * @param toolCall - Checked call of an offered tool.
   * @returns True only when the call's tool was saved as Just run when the
   * round's calls arrived. Sends nothing.
   */
  public isToolCallAllowedAtOnce(toolCall: ChatToolCall): boolean {
    return this.#justRunToolNames.has(toolCall.toolName)
  }

  /**
   * Shows one checked call to the person and waits for their answer.
   *
   * @param toolCall - Checked call that is not allowed at once.
   * @returns Resolves with the person's answer, or with undefined when the
   * reply was stopped while the prompt waited; never rejects.
   * @remarks The prompt is sent in the same synchronous step. The caller
   * stores the call as awaiting approval first, so a client that sees the
   * prompt can read the call it asks about.
   */
  public sendToolApprovalPrompt(
    toolCall: ChatToolCall
  ): Promise<ChatToolApprovalAnswer | undefined> {
    return this.#sendToolApprovalPrompt(toolCall)
  }
}
