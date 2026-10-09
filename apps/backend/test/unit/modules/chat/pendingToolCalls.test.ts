import type {
  ChatGenerationEvent,
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

/** Answer a client gives to a call. */
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

    void pendingToolCalls.sendToolCall(FIRST_CALL, sendEvent)

    expect(sentEvents).toEqual([{ type: "tool-call", call: FIRST_CALL }])
    expect(pendingToolCalls.toolCalls).toEqual([FIRST_CALL])
  })

  it("lists waiting calls in send order and drops each once it is answered", () => {
    const { pendingToolCalls, sendEvent } = createRecordingCalls()
    void pendingToolCalls.sendToolCall(FIRST_CALL, sendEvent)
    void pendingToolCalls.sendToolCall(SECOND_CALL, sendEvent)

    pendingToolCalls.resolveToolCall(FIRST_CALL.id, SUCCEEDED_RESULT)

    expect(pendingToolCalls.toolCalls).toEqual([SECOND_CALL])
  })

  it("resumes a call with its answer once and refuses a second answer", async () => {
    const { pendingToolCalls, sendEvent } = createRecordingCalls()
    const answer = pendingToolCalls.sendToolCall(FIRST_CALL, sendEvent)

    expect(
      pendingToolCalls.resolveToolCall(FIRST_CALL.id, SUCCEEDED_RESULT)
    ).toBe(true)
    expect(
      pendingToolCalls.resolveToolCall(FIRST_CALL.id, SUCCEEDED_RESULT)
    ).toBe(false)
    expect(await answer).toBe(SUCCEEDED_RESULT)
  })

  it("refuses an answer to a call it does not hold", () => {
    const { pendingToolCalls } = createRecordingCalls()

    expect(
      pendingToolCalls.resolveToolCall(FIRST_CALL.id, SUCCEEDED_RESULT)
    ).toBe(false)
  })

  it("ends every wait without an answer when cancelled and refuses later answers", async () => {
    const { pendingToolCalls, sendEvent } = createRecordingCalls()
    const firstAnswer = pendingToolCalls.sendToolCall(FIRST_CALL, sendEvent)
    const secondAnswer = pendingToolCalls.sendToolCall(SECOND_CALL, sendEvent)

    pendingToolCalls.cancelToolCalls()

    expect(await firstAnswer).toBeUndefined()
    expect(await secondAnswer).toBeUndefined()
    expect(pendingToolCalls.toolCalls).toEqual([])
    expect(
      pendingToolCalls.resolveToolCall(FIRST_CALL.id, SUCCEEDED_RESULT)
    ).toBe(false)
  })

  it("neither lists nor sends a call made after cancelling, and ends its wait at once", async () => {
    const { pendingToolCalls, sendEvent, sentEvents } = createRecordingCalls()
    pendingToolCalls.cancelToolCalls()

    const answer = pendingToolCalls.sendToolCall(FIRST_CALL, sendEvent)

    expect(await answer).toBeUndefined()
    expect(sentEvents).toEqual([])
    expect(pendingToolCalls.toolCalls).toEqual([])
  })

  it("rejects a second call with a waiting call's identifier without sending it", () => {
    const { pendingToolCalls, sendEvent, sentEvents } = createRecordingCalls()
    void pendingToolCalls.sendToolCall(FIRST_CALL, sendEvent)

    expect(() => pendingToolCalls.sendToolCall(FIRST_CALL, sendEvent)).toThrow(
      "A tool call with this identifier is already waiting"
    )
    expect(sentEvents).toHaveLength(1)
  })

  it("returns a list that cannot be changed", () => {
    const { pendingToolCalls, sendEvent } = createRecordingCalls()
    void pendingToolCalls.sendToolCall(FIRST_CALL, sendEvent)

    expect(Object.isFrozen(pendingToolCalls.toolCalls)).toBe(true)
  })
})
