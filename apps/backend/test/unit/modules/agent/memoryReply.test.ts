import { describe, expect, it } from "vitest"
import MemoryReply from "../../../../src/modules/agent/memoryReply"
import type { ReplyPartDraft } from "../../../../src/modules/agent/replyPartSequence"
import { ASK_ME_TOOL_CALL_DECISION } from "../../support/conversationFixtures"

/** Matches a UUIDv7 the reply gave a part. */
const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Identifier of the tool call most cases store. */
const TOOL_CALL_ID = "0190a3f2-7b1c-7d3e-8f45-6a7b8c9d0e1f"

/**
 * Builds a draft of a tool call.
 *
 * @param status - Status the call starts in.
 * @param round - Round of the call.
 * @param id - Identifier of the call.
 * @returns The draft.
 */
function buildToolCallDraft(
  status: "awaiting-approval" | "running",
  round = 0,
  id = TOOL_CALL_ID
): ReplyPartDraft {
  return {
    kind: "tool-call",
    id,
    round,
    toolName: "search_tools",
    argumentText: '{"query":"web"}',
    decision: ASK_ME_TOOL_CALL_DECISION,
    status
  }
}

describe("MemoryReply", () => {
  it("starts streaming", () => {
    expect(new MemoryReply(2).findReplyStatus()).toBe("streaming")
  })

  it("keeps a reasoning or text part under a new UUIDv7 and appends its fragments", () => {
    const reply = new MemoryReply(2)

    const part = reply.createReplyPart({
      kind: "text",
      round: 0,
      content: "Found"
    })
    const updatedAt =
      part === undefined
        ? undefined
        : reply.updateReplyPartContent(part.id, " it.")

    expect(part).toMatchObject({ kind: "text", round: 0, content: "Found" })
    expect(part?.id).toMatch(UUID_V7_PATTERN)
    expect(updatedAt).toEqual(expect.any(String))
  })

  it("refuses to append to a part it does not keep, or to a tool call", () => {
    const reply = new MemoryReply(2)
    reply.createReplyPart(buildToolCallDraft("running"))

    expect(reply.updateReplyPartContent(TOOL_CALL_ID, "text")).toBeUndefined()
    expect(
      reply.updateReplyPartContent("0190a3f2-0000-7000-8000-000000000000", "x")
    ).toBeUndefined()
  })

  it("throws for an empty fragment", () => {
    const reply = new MemoryReply(2)
    const part = reply.createReplyPart({
      kind: "reasoning",
      round: 0,
      content: "Think"
    })

    expect(() => reply.updateReplyPartContent(part?.id ?? "", "")).toThrow(
      "Reply part fragment must not be empty"
    )
  })

  it.each([
    [
      "running",
      { status: "succeeded", result: "Listed.", sources: [] },
      { status: "succeeded", result: "Listed.", sourceNumbers: [] }
    ],
    [
      "running",
      { status: "failed", result: "Broke." },
      { status: "failed", result: "Broke." }
    ],
    ["awaiting-approval", { status: "running" }, { status: "running" }],
    [
      "awaiting-approval",
      { status: "rejected", result: "Not allowed.", reason: "declined" },
      { status: "rejected", result: "Not allowed." }
    ],
    [
      "awaiting-approval",
      { status: "expired", result: "Nobody answered." },
      { status: "failed", result: "Nobody answered." }
    ]
  ] as const)(
    "changes a %s tool call as %o",
    (startStatus, change, expected) => {
      const reply = new MemoryReply(2)
      reply.createReplyPart(buildToolCallDraft(startStatus))

      expect(reply.updateReplyToolCall(TOOL_CALL_ID, change)).toMatchObject({
        kind: "tool-call",
        id: TOOL_CALL_ID,
        toolName: "search_tools",
        ...expected
      })
    }
  )

  it.each([
    ["running", { status: "running" }],
    ["running", { status: "rejected", result: "No.", reason: "declined" }],
    ["running", { status: "expired", result: "Nobody answered." }],
    ["awaiting-approval", { status: "succeeded", result: "", sources: [] }],
    ["awaiting-approval", { status: "failed", result: "Broke." }]
  ] as const)(
    "refuses a change a %s tool call does not follow: %o",
    (startStatus, change) => {
      const reply = new MemoryReply(2)
      reply.createReplyPart(buildToolCallDraft(startStatus))

      expect(reply.updateReplyToolCall(TOOL_CALL_ID, change)).toBeUndefined()
    }
  )

  it("refuses a change of a tool call it does not keep", () => {
    expect(
      new MemoryReply(2).updateReplyToolCall(TOOL_CALL_ID, {
        status: "running"
      })
    ).toBeUndefined()
  })

  it("refuses a tool call of a round past its limit, and keeps text of any round", () => {
    const reply = new MemoryReply(2)

    const lastAllowed = reply.createReplyPart(buildToolCallDraft("running", 1))
    const refused = reply.createReplyPart(
      buildToolCallDraft("running", 2, "0190a3f2-7b1c-7d3e-8f45-6a7b8c9d0e20")
    )
    const text = reply.createReplyPart({
      kind: "text",
      round: 2,
      content: "Done."
    })

    expect(lastAllowed).toMatchObject({ round: 1, status: "running" })
    expect(refused).toBeUndefined()
    expect(text).toMatchObject({ round: 2, content: "Done." })
    expect(reply.findReplyStatus()).toBe("streaming")
  })

  it("stores its final state once and refuses every write after it", () => {
    const reply = new MemoryReply(2)
    const part = reply.createReplyPart({
      kind: "text",
      round: 0,
      content: "Found"
    })
    reply.createReplyPart(buildToolCallDraft("running"))

    const first = reply.updateAssistantMessageState({
      status: "completed",
      finishReason: "stop"
    })
    const second = reply.updateAssistantMessageState({ status: "failed" })

    expect(first).toBe(true)
    expect(second).toBe(false)
    expect(reply.findReplyStatus()).toBe("completed")
    expect(
      reply.createReplyPart({ kind: "text", round: 1, content: "More" })
    ).toBeUndefined()
    expect(
      reply.updateReplyPartContent(part?.id ?? "", " more")
    ).toBeUndefined()
    expect(
      reply.updateReplyToolCall(TOOL_CALL_ID, {
        status: "failed",
        result: "Late."
      })
    ).toBeUndefined()
  })

  it.each(["interrupted", "failed"] as const)(
    "reads a reply finalized as %s",
    (status) => {
      const reply = new MemoryReply(2)

      reply.updateAssistantMessageState({ status })

      expect(reply.findReplyStatus()).toBe(status)
    }
  )
})
