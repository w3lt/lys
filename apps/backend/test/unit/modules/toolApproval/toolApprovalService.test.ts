import type { ChatToolCall } from "@lys/protocol"
import { describe, expect, it, vi } from "vitest"
import type { JustRunToolNamesRead } from "../../../../src/infrastructure/settings/justRunToolsFile"
import ToolApprovalService, {
  type ReadJustRunToolNames
} from "../../../../src/modules/toolApproval/toolApprovalService"
import type { SendToolApprovalPrompt } from "../../../../src/modules/toolApproval/toolCallGate"
import { createFixtureUuidV7 } from "../../support/conversationFixtures"

/** Call of the read-page tool. */
const PAGE_CALL = Object.freeze({
  id: createFixtureUuidV7(10),
  toolName: "read_page",
  arguments: Object.freeze({ url: "https://example.com/" })
} satisfies ChatToolCall)

/** Call of the web search tool. */
const SEARCH_CALL = Object.freeze({
  id: createFixtureUuidV7(11),
  toolName: "web_search",
  arguments: Object.freeze({ query: "lys" })
} satisfies ChatToolCall)

/**
 * Builds the read result of saved Just run names.
 *
 * @param toolNames - Names saved as Just run.
 * @returns The `read` result.
 */
function buildRead(toolNames: readonly string[]): JustRunToolNamesRead {
  return { status: "read", toolNames: new Set(toolNames) }
}

/**
 * Creates a prompt sender whose prompts the person allows.
 *
 * @returns A spy recording every prompted call.
 */
function createAllowingPromptSender() {
  return vi.fn<SendToolApprovalPrompt>(async () => ({ status: "allowed" }))
}

describe("ToolApprovalService", () => {
  it("runs the tools saved as Just run and prompts for every other tool", async () => {
    const service = new ToolApprovalService(async () =>
      buildRead(["read_page"])
    )
    const sendToolApprovalPrompt = createAllowingPromptSender()

    const gate = await service.createToolCallGate(
      sendToolApprovalPrompt,
      vi.fn()
    )
    gate.sendToolApprovalRequest(PAGE_CALL)
    gate.sendToolApprovalRequest(SEARCH_CALL)

    expect(sendToolApprovalPrompt.mock.calls).toEqual([[SEARCH_CALL]])
  })

  it("reads the saved choices once per gate, not once per call", async () => {
    const readJustRunToolNames = vi.fn<ReadJustRunToolNames>(async () =>
      buildRead([])
    )
    const service = new ToolApprovalService(readJustRunToolNames)

    const gate = await service.createToolCallGate(
      createAllowingPromptSender(),
      vi.fn()
    )
    gate.sendToolApprovalRequest(PAGE_CALL)
    gate.sendToolApprovalRequest(SEARCH_CALL)

    expect(readJustRunToolNames).toHaveBeenCalledOnce()
  })

  it("follows a choice changed between two rounds", async () => {
    const reads = [buildRead([]), buildRead(["read_page"]), buildRead([])]
    const service = new ToolApprovalService(async () => {
      const read = reads.shift()
      if (read === undefined) throw new Error("Read more often than expected.")
      return read
    })
    const sendToolApprovalPrompt = createAllowingPromptSender()

    for (let round = 0; round < 3; round += 1) {
      const gate = await service.createToolCallGate(
        sendToolApprovalPrompt,
        vi.fn()
      )
      gate.sendToolApprovalRequest(PAGE_CALL)
    }

    expect(sendToolApprovalPrompt).toHaveBeenCalledTimes(2)
  })

  it("prompts for every tool and reports once when the saved choices cannot be read", async () => {
    const service = new ToolApprovalService(async () => ({
      status: "unreadable"
    }))
    const sendToolApprovalPrompt = createAllowingPromptSender()
    const reportSettingsUnreadable = vi.fn<() => void>()

    const gate = await service.createToolCallGate(
      sendToolApprovalPrompt,
      reportSettingsUnreadable
    )
    gate.sendToolApprovalRequest(PAGE_CALL)
    gate.sendToolApprovalRequest(SEARCH_CALL)

    expect(sendToolApprovalPrompt.mock.calls).toEqual([
      [PAGE_CALL],
      [SEARCH_CALL]
    ])
    expect(reportSettingsUnreadable).toHaveBeenCalledOnce()
  })

  it("does not report anything when the saved choices were read", async () => {
    const service = new ToolApprovalService(async () => buildRead([]))
    const reportSettingsUnreadable = vi.fn<() => void>()

    await service.createToolCallGate(
      createAllowingPromptSender(),
      reportSettingsUnreadable
    )

    expect(reportSettingsUnreadable).not.toHaveBeenCalled()
  })

  it("rejects with the reader's failure", async () => {
    const failure = new Error("Closing settings.json failed.")
    const service = new ToolApprovalService(async () => {
      throw failure
    })

    await expect(
      service.createToolCallGate(createAllowingPromptSender(), vi.fn())
    ).rejects.toBe(failure)
  })
})
