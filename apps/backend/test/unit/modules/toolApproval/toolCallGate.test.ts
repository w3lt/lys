import type { ChatToolApprovalAnswer, ChatToolCall } from "@lys/protocol"
import { describe, expect, it, vi } from "vitest"
import ToolCallGate, {
  type SendToolApprovalPrompt
} from "../../../../src/modules/toolApproval/toolCallGate"
import { createFixtureUuidV7 } from "../../support/conversationFixtures"

/** Call of a tool the person saved as Just run in these cases. */
const PAGE_CALL = Object.freeze({
  id: createFixtureUuidV7(10),
  toolName: "read_page",
  arguments: Object.freeze({ url: "https://example.com/" })
} satisfies ChatToolCall)

/** Call of a tool left on Ask me in these cases. */
const READ_CALL = Object.freeze({
  id: createFixtureUuidV7(11),
  toolName: "read_text_file",
  arguments: Object.freeze({ path: "/notes/todo.md" })
} satisfies ChatToolCall)

/** Answer of a person who rejected a call with a note. */
const DECLINED_ANSWER = Object.freeze({
  status: "rejected",
  reason: "declined",
  content: "The person declined this call. Their note: not that folder"
} satisfies ChatToolApprovalAnswer)

/**
 * Creates a prompt sender that answers every prompt with one answer.
 *
 * @param answer - Answer each prompt resolves with; undefined models a reply
 * stopped while the prompt waited.
 * @returns A spy recording every prompted call.
 */
function createPromptSender(answer: ChatToolApprovalAnswer | undefined) {
  return vi.fn<SendToolApprovalPrompt>(async () => answer)
}

describe("ToolCallGate", () => {
  it("allows a call of a tool on Just run at once, without prompting the person", () => {
    const sendToolApprovalPrompt = createPromptSender(undefined)
    const gate = new ToolCallGate(
      new Set(["read_page"]),
      sendToolApprovalPrompt
    )

    expect(gate.isToolCallAllowedAtOnce(PAGE_CALL)).toBe(true)
    expect(sendToolApprovalPrompt).not.toHaveBeenCalled()
  })

  it("does not allow a call of a tool on Ask me at once, and sends nothing to decide it", () => {
    const sendToolApprovalPrompt = createPromptSender(undefined)
    const gate = new ToolCallGate(
      new Set(["read_page"]),
      sendToolApprovalPrompt
    )

    expect(gate.isToolCallAllowedAtOnce(READ_CALL)).toBe(false)
    expect(sendToolApprovalPrompt).not.toHaveBeenCalled()
  })

  it("prompts the person in the same step", async () => {
    const sendToolApprovalPrompt = createPromptSender({ status: "allowed" })
    const gate = new ToolCallGate(new Set(), sendToolApprovalPrompt)

    const answer = gate.sendToolApprovalPrompt(READ_CALL)

    expect(sendToolApprovalPrompt.mock.calls).toEqual([[READ_CALL]])
    await answer
  })

  it.each<[string, ChatToolApprovalAnswer | undefined]>([
    ["an allowed call", { status: "allowed" }],
    ["a rejected call", DECLINED_ANSWER],
    ["a reply stopped while the prompt waited", undefined]
  ])(
    "resolves the prompt with the person's answer for %s",
    async (_label, answer) => {
      const gate = new ToolCallGate(new Set(), createPromptSender(answer))

      expect(await gate.sendToolApprovalPrompt(READ_CALL)).toEqual(answer)
    }
  )

  it("keeps the choices it was created with when the given set changes later", () => {
    const justRunToolNames = new Set<string>()
    const gate = new ToolCallGate(
      justRunToolNames,
      createPromptSender({ status: "allowed" })
    )
    justRunToolNames.add("read_text_file")

    expect(gate.isToolCallAllowedAtOnce(READ_CALL)).toBe(false)
  })
})
