import type { ChatToolApprovalAnswer, ChatToolCall } from "@lys/protocol"
import { describe, expect, it, vi } from "vitest"
import ToolCallGate, {
  type SendToolApprovalPrompt,
  type StoreStartedToolCall
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

/**
 * Creates a store step that answers every call with one outcome.
 *
 * @param isStored - Whether the reply accepts the call.
 * @returns A spy recording the state each call was stored in.
 */
function createStore(isStored: boolean) {
  return vi.fn<StoreStartedToolCall>(() => isStored)
}

describe("ToolCallGate", () => {
  it("stores a call of a tool on Just run as running and allows it without prompting the person", () => {
    const sendToolApprovalPrompt = createPromptSender(undefined)
    const gate = new ToolCallGate(
      new Set(["read_page"]),
      sendToolApprovalPrompt
    )
    const storeToolCall = createStore(true)

    expect(gate.startToolCall(PAGE_CALL, storeToolCall)).toEqual({
      status: "allowed"
    })
    expect(storeToolCall.mock.calls).toEqual([["running"]])
    expect(sendToolApprovalPrompt).not.toHaveBeenCalled()
  })

  it("stores a call of a tool on Ask me as awaiting approval, then prompts the person in the same step", async () => {
    const steps: string[] = []
    const gate = new ToolCallGate(new Set(["read_page"]), async (toolCall) => {
      steps.push(`prompt ${toolCall.toolName}`)
      return { status: "allowed" }
    })

    const start = gate.startToolCall(READ_CALL, (status) => {
      steps.push(`store ${status}`)
      return true
    })

    expect(steps).toEqual(["store awaiting-approval", "prompt read_text_file"])
    expect(start.status).toBe("prompted")
    if (start.status === "prompted") await start.answer
  })

  it.each<[string, ChatToolApprovalAnswer | undefined]>([
    ["an allowed call", { status: "allowed" }],
    ["a rejected call", DECLINED_ANSWER],
    ["a reply stopped while the prompt waited", undefined]
  ])(
    "settles the prompted call's answer with the person's answer for %s",
    async (_label, answer) => {
      const gate = new ToolCallGate(new Set(), createPromptSender(answer))

      const start = gate.startToolCall(READ_CALL, createStore(true))

      expect(start.status).toBe("prompted")
      if (start.status === "prompted")
        expect(await start.answer).toEqual(answer)
    }
  )

  it.each([
    ["on Just run", PAGE_CALL],
    ["on Ask me", READ_CALL]
  ])(
    "ends a call of a tool %s that the reply refuses to store, without prompting the person",
    (_label, toolCall) => {
      const sendToolApprovalPrompt = createPromptSender({ status: "allowed" })
      const gate = new ToolCallGate(
        new Set(["read_page"]),
        sendToolApprovalPrompt
      )

      expect(gate.startToolCall(toolCall, createStore(false))).toEqual({
        status: "ended"
      })
      expect(sendToolApprovalPrompt).not.toHaveBeenCalled()
    }
  )

  it("keeps the choices it was created with when the given set changes later", () => {
    const justRunToolNames = new Set<string>()
    const gate = new ToolCallGate(
      justRunToolNames,
      createPromptSender({ status: "allowed" })
    )
    justRunToolNames.add("read_text_file")
    const storeToolCall = createStore(true)

    gate.startToolCall(READ_CALL, storeToolCall)

    expect(storeToolCall.mock.calls).toEqual([["awaiting-approval"]])
  })
})
