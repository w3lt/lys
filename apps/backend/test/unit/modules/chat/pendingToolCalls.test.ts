import type {
  ChatGenerationEvent,
  ChatToolApprovalAnswer,
  ChatToolCall,
  ChatToolResult
} from "@lys/protocol"
import { describe, expect, it } from "vitest"
import PendingToolCalls from "../../../../src/modules/chat/pendingToolCalls"
import { createFixtureUuidV7 } from "../../support/conversationFixtures"

/** First call a reply waits on. */
const FIRST_CALL = Object.freeze({
  id: createFixtureUuidV7(10),
  toolName: "read_text_file",
  arguments: Object.freeze({ path: "/notes/a.md" })
} satisfies ChatToolCall)

/** Second call a reply waits on. */
const SECOND_CALL = Object.freeze({
  id: createFixtureUuidV7(11),
  toolName: "read_text_file",
  arguments: Object.freeze({ path: "/notes/b.md" })
} satisfies ChatToolCall)

/** Call of a tool the backend runs. */
const BACKEND_CALL = Object.freeze({
  id: createFixtureUuidV7(12),
  toolName: "read_page",
  arguments: Object.freeze({ url: "https://example.com/" })
} satisfies ChatToolCall)

/** Answer of a person who allowed a call. */
const ALLOWED_ANSWER = Object.freeze({
  status: "allowed"
} satisfies ChatToolApprovalAnswer)

/** Answer of a person who rejected a call. */
const DECLINED_ANSWER = Object.freeze({
  status: "rejected",
  reason: "declined",
  content: "The person declined this call."
} satisfies ChatToolApprovalAnswer)

/** Result a client sends for a call it ran. */
const SUCCEEDED_RESULT = Object.freeze({
  status: "succeeded",
  content: "Buy milk"
} satisfies ChatToolResult)

/**
 * Creates waiting calls with a sender that records every event.
 *
 * @returns The waiting calls, the sender, and the sent events in send order.
 */
function createRecordingCalls() {
  const sentEvents: ChatGenerationEvent[] = []
  const pendingToolCalls = new PendingToolCalls()
  const sendEvent = (event: ChatGenerationEvent) => {
    sentEvents.push(event)
  }
  return { pendingToolCalls, sendEvent, sentEvents }
}

describe("PendingToolCalls", () => {
  it("lists a call and sends its event in the same step", () => {
    const { pendingToolCalls, sendEvent, sentEvents } = createRecordingCalls()

    void pendingToolCalls.sendClientToolCall(FIRST_CALL, sendEvent)

    expect(sentEvents).toEqual([{ type: "tool-call", call: FIRST_CALL }])
    expect(pendingToolCalls.snapshot).toEqual({
      toolCalls: [FIRST_CALL],
      toolApprovals: []
    })
  })

  it("lists waiting calls in send order and drops each once it is answered", () => {
    const { pendingToolCalls, sendEvent } = createRecordingCalls()
    void pendingToolCalls.sendClientToolCall(FIRST_CALL, sendEvent)
    void pendingToolCalls.sendClientToolCall(SECOND_CALL, sendEvent)

    pendingToolCalls.resolveToolCall(FIRST_CALL.id, SUCCEEDED_RESULT)

    expect(pendingToolCalls.snapshot.toolCalls).toEqual([SECOND_CALL])
  })

  it("resumes a call with its answer once and refuses a second answer", async () => {
    const { pendingToolCalls, sendEvent } = createRecordingCalls()
    const answer = pendingToolCalls.sendClientToolCall(FIRST_CALL, sendEvent)

    expect(
      pendingToolCalls.resolveToolCall(FIRST_CALL.id, SUCCEEDED_RESULT)
    ).toBe("accepted")
    expect(
      pendingToolCalls.resolveToolCall(FIRST_CALL.id, SUCCEEDED_RESULT)
    ).toBe("not-pending")
    expect(await answer).toBe(SUCCEEDED_RESULT)
  })

  it("refuses an answer to a call it does not hold", () => {
    const { pendingToolCalls } = createRecordingCalls()

    expect(
      pendingToolCalls.resolveToolCall(FIRST_CALL.id, SUCCEEDED_RESULT)
    ).toBe("not-pending")
    expect(
      pendingToolCalls.resolveToolCall(FIRST_CALL.id, ALLOWED_ANSWER)
    ).toBe("not-pending")
  })

  it("ends every wait without an answer when cancelled and refuses later answers", async () => {
    const { pendingToolCalls, sendEvent } = createRecordingCalls()
    const firstAnswer = pendingToolCalls.sendClientToolCall(
      FIRST_CALL,
      sendEvent
    )
    const promptAnswer = pendingToolCalls.sendToolApprovalPrompt(
      BACKEND_CALL,
      sendEvent
    )

    pendingToolCalls.cancelToolCalls()

    expect(await firstAnswer).toBeUndefined()
    expect(await promptAnswer).toBeUndefined()
    expect(pendingToolCalls.snapshot).toEqual({
      toolCalls: [],
      toolApprovals: []
    })
    expect(
      pendingToolCalls.resolveToolCall(FIRST_CALL.id, SUCCEEDED_RESULT)
    ).toBe("not-pending")
    expect(
      pendingToolCalls.resolveToolCall(BACKEND_CALL.id, ALLOWED_ANSWER)
    ).toBe("not-pending")
  })

  it("neither lists nor sends a call or prompt made after cancelling, and ends its wait at once", async () => {
    const { pendingToolCalls, sendEvent, sentEvents } = createRecordingCalls()
    pendingToolCalls.cancelToolCalls()

    const answer = pendingToolCalls.sendClientToolCall(FIRST_CALL, sendEvent)
    const promptAnswer = pendingToolCalls.sendToolApprovalPrompt(
      BACKEND_CALL,
      sendEvent
    )

    expect(await answer).toBeUndefined()
    expect(await promptAnswer).toBeUndefined()
    expect(sentEvents).toEqual([])
    expect(pendingToolCalls.snapshot).toEqual({
      toolCalls: [],
      toolApprovals: []
    })
  })

  it("rejects a second call with a waiting call's identifier without sending it", () => {
    const { pendingToolCalls, sendEvent, sentEvents } = createRecordingCalls()
    void pendingToolCalls.sendClientToolCall(FIRST_CALL, sendEvent)

    expect(() =>
      pendingToolCalls.sendToolApprovalPrompt(FIRST_CALL, sendEvent)
    ).toThrow("A tool call with this identifier is already waiting")
    expect(sentEvents).toHaveLength(1)
  })

  it("lists a prompt apart from calls and sends a tool-approval event in the same step", () => {
    const { pendingToolCalls, sendEvent, sentEvents } = createRecordingCalls()
    void pendingToolCalls.sendClientToolCall(FIRST_CALL, sendEvent)

    void pendingToolCalls.sendToolApprovalPrompt(BACKEND_CALL, sendEvent)

    expect(sentEvents).toEqual([
      { type: "tool-call", call: FIRST_CALL },
      { type: "tool-approval", call: BACKEND_CALL }
    ])
    expect(pendingToolCalls.snapshot).toEqual({
      toolCalls: [FIRST_CALL],
      toolApprovals: [BACKEND_CALL]
    })
  })

  it.each([
    ["allowed", ALLOWED_ANSWER],
    ["rejected", DECLINED_ANSWER]
  ])("resumes a prompt answered as %s", async (_status, answer) => {
    const { pendingToolCalls, sendEvent } = createRecordingCalls()
    const waitedAnswer = pendingToolCalls.sendToolApprovalPrompt(
      BACKEND_CALL,
      sendEvent
    )

    expect(pendingToolCalls.resolveToolCall(BACKEND_CALL.id, answer)).toBe(
      "accepted"
    )
    expect(await waitedAnswer).toBe(answer)
    expect(pendingToolCalls.snapshot.toolApprovals).toEqual([])
  })

  it("keeps a call waiting for its result when it is answered as allowed", async () => {
    const { pendingToolCalls, sendEvent } = createRecordingCalls()
    const waitedResult = pendingToolCalls.sendClientToolCall(
      FIRST_CALL,
      sendEvent
    )

    expect(
      pendingToolCalls.resolveToolCall(FIRST_CALL.id, ALLOWED_ANSWER)
    ).toBe("not-pending")
    expect(pendingToolCalls.snapshot.toolCalls).toEqual([FIRST_CALL])
    pendingToolCalls.cancelToolCalls()
    expect(await waitedResult).toBeUndefined()
  })

  it("keeps a prompt waiting when it is answered with a result", async () => {
    const { pendingToolCalls, sendEvent } = createRecordingCalls()
    const waitedAnswer = pendingToolCalls.sendToolApprovalPrompt(
      BACKEND_CALL,
      sendEvent
    )

    expect(
      pendingToolCalls.resolveToolCall(BACKEND_CALL.id, SUCCEEDED_RESULT)
    ).toBe("not-pending")
    expect(pendingToolCalls.snapshot.toolApprovals).toEqual([BACKEND_CALL])
    pendingToolCalls.cancelToolCalls()
    expect(await waitedAnswer).toBeUndefined()
  })

  it("sends a call to run under the identifier of its answered prompt", async () => {
    const { pendingToolCalls, sendEvent, sentEvents } = createRecordingCalls()
    const prompt = pendingToolCalls.sendToolApprovalPrompt(
      FIRST_CALL,
      sendEvent
    )
    pendingToolCalls.resolveToolCall(FIRST_CALL.id, ALLOWED_ANSWER)
    await prompt

    const result = pendingToolCalls.sendClientToolCall(FIRST_CALL, sendEvent)

    expect(sentEvents).toEqual([
      { type: "tool-approval", call: FIRST_CALL },
      { type: "tool-call", call: FIRST_CALL }
    ])
    expect(
      pendingToolCalls.resolveToolCall(FIRST_CALL.id, SUCCEEDED_RESULT)
    ).toBe("accepted")
    expect(await result).toBe(SUCCEEDED_RESULT)
  })

  it("returns a snapshot whose lists cannot be changed", () => {
    const { pendingToolCalls, sendEvent } = createRecordingCalls()
    void pendingToolCalls.sendClientToolCall(FIRST_CALL, sendEvent)
    void pendingToolCalls.sendToolApprovalPrompt(BACKEND_CALL, sendEvent)

    const { snapshot } = pendingToolCalls

    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.toolCalls)).toBe(true)
    expect(Object.isFrozen(snapshot.toolApprovals)).toBe(true)
  })
})
