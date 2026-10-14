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
  it("allows a call of a tool on Just run in the same step, without prompting the person", () => {
    const sendToolApprovalPrompt = createPromptSender(undefined)
    const gate = new ToolCallGate(
      new Set(["read_page"]),
      sendToolApprovalPrompt
    )

    const request = gate.sendToolApprovalRequest(PAGE_CALL)

    expect(request).toEqual({ status: "allowed" })
    expect(sendToolApprovalPrompt).not.toHaveBeenCalled()
  })

  it("prompts the person in the same step for a tool on Ask me", async () => {
    const sendToolApprovalPrompt = createPromptSender({ status: "allowed" })
    const gate = new ToolCallGate(
      new Set(["read_page"]),
      sendToolApprovalPrompt
    )

    const request = gate.sendToolApprovalRequest(READ_CALL)

    expect(request.status).toBe("prompted")
    expect(sendToolApprovalPrompt.mock.calls).toEqual([[READ_CALL]])
    if (request.status === "prompted") await request.answer
  })

  it.each<[string, ChatToolApprovalAnswer | undefined]>([
    ["an allowed call", { status: "allowed" }],
    ["a rejected call", DECLINED_ANSWER],
    ["a reply stopped while the prompt waited", undefined]
  ])(
    "resolves the prompt with the person's answer for %s",
    async (_label, answer) => {
      const gate = new ToolCallGate(new Set(), createPromptSender(answer))

      const request = gate.sendToolApprovalRequest(READ_CALL)

      if (request.status !== "prompted") throw new Error("Expected a prompt.")
      expect(await request.answer).toEqual(answer)
    }
  )

  it("keeps the choices it was created with when the given set changes later", () => {
    const justRunToolNames = new Set<string>()
    const sendToolApprovalPrompt = createPromptSender({ status: "allowed" })
    const gate = new ToolCallGate(justRunToolNames, sendToolApprovalPrompt)
    justRunToolNames.add("read_text_file")

    const request = gate.sendToolApprovalRequest(READ_CALL)

    expect(request.status).toBe("prompted")
    expect(sendToolApprovalPrompt).toHaveBeenCalledOnce()
  })
})
