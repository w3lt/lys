import {
  TOOL_APPROVAL_PROMPT_TIME_LIMIT_MINUTES,
  type ChatGenerationEvent,
  type ChatToolApprovalAnswer,
  type ChatToolApprovalApiRequestBody,
  type ChatToolCall,
  type ChatToolResult
} from "@lys/protocol"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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

/** Token no prompt was given: right shape, wrong value. */
const WRONG_TOKEN = "A".repeat(43)

/** Shape of every token a prompt carries. */
const APPROVAL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

/** Milliseconds after which a prompt expires. */
const PROMPT_TIME_LIMIT_MS = TOOL_APPROVAL_PROMPT_TIME_LIMIT_MINUTES * 60_000

/** Result a client sends for a call it ran. */
const SUCCEEDED_RESULT = Object.freeze({
  status: "succeeded",
  content: "Buy milk"
} satisfies ChatToolResult)

/**
 * Adds a prompt's token to an answer, as the tool-approval route's body does.
 *
 * @param answer - The person's answer.
 * @param approvalToken - Token the body carries.
 * @returns A body for {@link PendingToolCalls.resolveToolCall}.
 */
function withToken(
  answer: ChatToolApprovalAnswer,
  approvalToken: string
): ChatToolApprovalApiRequestBody {
  return { ...answer, approvalToken }
}

/**
 * Finds the token the prompt of one call carried.
 *
 * @param sentEvents - Events sent so far, in send order.
 * @param toolCall - Call whose prompt was sent.
 * @returns The prompt's token.
 * @throws When no `tool-approval` event was sent for the call.
 */
function findSentApprovalToken(
  sentEvents: readonly ChatGenerationEvent[],
  toolCall: ChatToolCall
): string {
  const prompt = sentEvents.find(
    (event) => event.type === "tool-approval" && event.call.id === toolCall.id
  )
  if (prompt?.type !== "tool-approval")
    throw new Error(`No prompt was sent for ${toolCall.id}`)
  return prompt.approvalToken
}

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
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

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
      pendingToolCalls.resolveToolCall(
        FIRST_CALL.id,
        withToken(ALLOWED_ANSWER, WRONG_TOKEN)
      )
    ).toBe("not-pending")
  })

  it("ends every wait without an answer when cancelled and refuses later answers", async () => {
    const { pendingToolCalls, sendEvent, sentEvents } = createRecordingCalls()
    const firstAnswer = pendingToolCalls.sendClientToolCall(
      FIRST_CALL,
      sendEvent
    )
    const promptAnswer = pendingToolCalls.sendToolApprovalPrompt(
      BACKEND_CALL,
      sendEvent
    )
    const approvalToken = findSentApprovalToken(sentEvents, BACKEND_CALL)

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
      pendingToolCalls.resolveToolCall(
        BACKEND_CALL.id,
        withToken(ALLOWED_ANSWER, approvalToken)
      )
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
    expect(vi.getTimerCount()).toBe(0)
  })

  it("rejects a second call with a waiting call's identifier without sending it", () => {
    const { pendingToolCalls, sendEvent, sentEvents } = createRecordingCalls()
    void pendingToolCalls.sendClientToolCall(FIRST_CALL, sendEvent)

    expect(() =>
      pendingToolCalls.sendToolApprovalPrompt(FIRST_CALL, sendEvent)
    ).toThrow("A tool call with this identifier is already waiting")
    expect(sentEvents).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("lists a prompt apart from calls and sends a tool-approval event with its token in the same step", () => {
    const { pendingToolCalls, sendEvent, sentEvents } = createRecordingCalls()
    void pendingToolCalls.sendClientToolCall(FIRST_CALL, sendEvent)

    void pendingToolCalls.sendToolApprovalPrompt(BACKEND_CALL, sendEvent)

    const approvalToken = findSentApprovalToken(sentEvents, BACKEND_CALL)
    expect(approvalToken).toMatch(APPROVAL_TOKEN_PATTERN)
    expect(sentEvents).toEqual([
      { type: "tool-call", call: FIRST_CALL },
      { type: "tool-approval", call: BACKEND_CALL, approvalToken }
    ])
    expect(pendingToolCalls.snapshot).toEqual({
      toolCalls: [FIRST_CALL],
      toolApprovals: [{ call: BACKEND_CALL, approvalToken }]
    })
  })

  it("gives each prompt its own token", () => {
    const { pendingToolCalls, sendEvent, sentEvents } = createRecordingCalls()

    void pendingToolCalls.sendToolApprovalPrompt(FIRST_CALL, sendEvent)
    void pendingToolCalls.sendToolApprovalPrompt(SECOND_CALL, sendEvent)

    const firstToken = findSentApprovalToken(sentEvents, FIRST_CALL)
    const secondToken = findSentApprovalToken(sentEvents, SECOND_CALL)
    expect(secondToken).toMatch(APPROVAL_TOKEN_PATTERN)
    expect(secondToken).not.toBe(firstToken)
  })

  it.each([
    ["a wrong token", () => WRONG_TOKEN],
    ["another prompt's token", (otherToken: string) => otherToken]
  ])(
    "refuses an answer with %s and keeps the prompt waiting for its own",
    async (_label, chooseToken) => {
      const { pendingToolCalls, sendEvent, sentEvents } = createRecordingCalls()
      const waitedAnswer = pendingToolCalls.sendToolApprovalPrompt(
        FIRST_CALL,
        sendEvent
      )
      void pendingToolCalls.sendToolApprovalPrompt(SECOND_CALL, sendEvent)
      const approvalToken = findSentApprovalToken(sentEvents, FIRST_CALL)
      const otherToken = findSentApprovalToken(sentEvents, SECOND_CALL)

      expect(
        pendingToolCalls.resolveToolCall(
          FIRST_CALL.id,
          withToken(ALLOWED_ANSWER, chooseToken(otherToken))
        )
      ).toBe("token-mismatch")
      expect(pendingToolCalls.snapshot.toolApprovals).toEqual([
        { call: FIRST_CALL, approvalToken },
        { call: SECOND_CALL, approvalToken: otherToken }
      ])
      expect(
        pendingToolCalls.resolveToolCall(
          FIRST_CALL.id,
          withToken(DECLINED_ANSWER, approvalToken)
        )
      ).toBe("accepted")
      expect(await waitedAnswer).toEqual(DECLINED_ANSWER)
    }
  )

  it("refuses a token sent again after its answer was accepted", async () => {
    const { pendingToolCalls, sendEvent, sentEvents } = createRecordingCalls()
    const waitedAnswer = pendingToolCalls.sendToolApprovalPrompt(
      FIRST_CALL,
      sendEvent
    )
    const approvalToken = findSentApprovalToken(sentEvents, FIRST_CALL)
    const body = withToken(DECLINED_ANSWER, approvalToken)

    expect(pendingToolCalls.resolveToolCall(FIRST_CALL.id, body)).toBe(
      "accepted"
    )
    expect(
      pendingToolCalls.resolveToolCall(
        FIRST_CALL.id,
        withToken(ALLOWED_ANSWER, approvalToken)
      )
    ).toBe("not-pending")
    expect(await waitedAnswer).toEqual(DECLINED_ANSWER)
  })

  it.each([
    ["allowed", ALLOWED_ANSWER],
    ["rejected", DECLINED_ANSWER]
  ])(
    "resumes a prompt answered as %s with its token, handing on the answer without the token",
    async (_status, answer) => {
      const { pendingToolCalls, sendEvent, sentEvents } = createRecordingCalls()
      const waitedAnswer = pendingToolCalls.sendToolApprovalPrompt(
        BACKEND_CALL,
        sendEvent
      )
      const approvalToken = findSentApprovalToken(sentEvents, BACKEND_CALL)

      expect(
        pendingToolCalls.resolveToolCall(
          BACKEND_CALL.id,
          withToken(answer, approvalToken)
        )
      ).toBe("accepted")
      expect(await waitedAnswer).toStrictEqual(answer)
      expect(pendingToolCalls.snapshot.toolApprovals).toEqual([])
    }
  )

  it("keeps a call waiting for its result when it is answered as allowed", async () => {
    const { pendingToolCalls, sendEvent } = createRecordingCalls()
    const waitedResult = pendingToolCalls.sendClientToolCall(
      FIRST_CALL,
      sendEvent
    )

    expect(
      pendingToolCalls.resolveToolCall(
        FIRST_CALL.id,
        withToken(ALLOWED_ANSWER, WRONG_TOKEN)
      )
    ).toBe("not-pending")
    expect(pendingToolCalls.snapshot.toolCalls).toEqual([FIRST_CALL])
    pendingToolCalls.cancelToolCalls()
    expect(await waitedResult).toBeUndefined()
  })

  it("keeps a prompt waiting when it is answered with a result", async () => {
    const { pendingToolCalls, sendEvent, sentEvents } = createRecordingCalls()
    const waitedAnswer = pendingToolCalls.sendToolApprovalPrompt(
      BACKEND_CALL,
      sendEvent
    )
    const approvalToken = findSentApprovalToken(sentEvents, BACKEND_CALL)

    expect(
      pendingToolCalls.resolveToolCall(BACKEND_CALL.id, SUCCEEDED_RESULT)
    ).toBe("not-pending")
    expect(pendingToolCalls.snapshot.toolApprovals).toEqual([
      { call: BACKEND_CALL, approvalToken }
    ])
    pendingToolCalls.cancelToolCalls()
    expect(await waitedAnswer).toBeUndefined()
  })

  it("sends a call to run under the identifier of its answered prompt", async () => {
    const { pendingToolCalls, sendEvent, sentEvents } = createRecordingCalls()
    const prompt = pendingToolCalls.sendToolApprovalPrompt(
      FIRST_CALL,
      sendEvent
    )
    const approvalToken = findSentApprovalToken(sentEvents, FIRST_CALL)
    pendingToolCalls.resolveToolCall(
      FIRST_CALL.id,
      withToken(ALLOWED_ANSWER, approvalToken)
    )
    await prompt

    const result = pendingToolCalls.sendClientToolCall(FIRST_CALL, sendEvent)

    expect(sentEvents).toEqual([
      { type: "tool-approval", call: FIRST_CALL, approvalToken },
      { type: "tool-call", call: FIRST_CALL }
    ])
    expect(
      pendingToolCalls.resolveToolCall(FIRST_CALL.id, SUCCEEDED_RESULT)
    ).toBe("accepted")
    expect(await result).toBe(SUCCEEDED_RESULT)
  })

  it("takes an answer that arrives just before the prompt's time limit, and the prompt never expires", async () => {
    const { pendingToolCalls, sendEvent, sentEvents } = createRecordingCalls()
    const outcome = pendingToolCalls.sendToolApprovalPrompt(
      BACKEND_CALL,
      sendEvent
    )
    const approvalToken = findSentApprovalToken(sentEvents, BACKEND_CALL)

    vi.advanceTimersByTime(PROMPT_TIME_LIMIT_MS - 1)
    const answerOutcome = pendingToolCalls.resolveToolCall(
      BACKEND_CALL.id,
      withToken(ALLOWED_ANSWER, approvalToken)
    )

    expect(answerOutcome).toBe("accepted")
    expect(vi.getTimerCount()).toBe(0)
    expect(await outcome).toEqual(ALLOWED_ANSWER)
  })

  it("ends a prompt at its time limit as expired and refuses its token from then on", async () => {
    const { pendingToolCalls, sendEvent, sentEvents } = createRecordingCalls()
    const outcome = pendingToolCalls.sendToolApprovalPrompt(
      BACKEND_CALL,
      sendEvent
    )
    const approvalToken = findSentApprovalToken(sentEvents, BACKEND_CALL)

    vi.advanceTimersByTime(PROMPT_TIME_LIMIT_MS)

    expect(await outcome).toEqual({ status: "expired" })
    expect(pendingToolCalls.snapshot).toEqual({
      toolCalls: [],
      toolApprovals: []
    })
    expect(
      pendingToolCalls.resolveToolCall(
        BACKEND_CALL.id,
        withToken(ALLOWED_ANSWER, approvalToken)
      )
    ).toBe("not-pending")
    expect(sentEvents).toHaveLength(1)
  })

  it("times each prompt from when it was sent, ending only the one that reached its limit", async () => {
    const { pendingToolCalls, sendEvent, sentEvents } = createRecordingCalls()
    const firstOutcome = pendingToolCalls.sendToolApprovalPrompt(
      FIRST_CALL,
      sendEvent
    )
    vi.advanceTimersByTime(PROMPT_TIME_LIMIT_MS / 2)
    void pendingToolCalls.sendToolApprovalPrompt(SECOND_CALL, sendEvent)
    const secondToken = findSentApprovalToken(sentEvents, SECOND_CALL)

    vi.advanceTimersByTime(PROMPT_TIME_LIMIT_MS / 2)

    expect(await firstOutcome).toEqual({ status: "expired" })
    expect(pendingToolCalls.snapshot.toolApprovals).toEqual([
      { call: SECOND_CALL, approvalToken: secondToken }
    ])
  })

  it("clears a prompt's timer when cancelled, so the prompt can no longer expire", async () => {
    const { pendingToolCalls, sendEvent } = createRecordingCalls()
    const outcome = pendingToolCalls.sendToolApprovalPrompt(
      BACKEND_CALL,
      sendEvent
    )

    pendingToolCalls.cancelToolCalls()

    expect(vi.getTimerCount()).toBe(0)
    expect(await outcome).toBeUndefined()
  })

  it("starts no timer for a call sent to run, which waits for its result past the prompt limit", async () => {
    const { pendingToolCalls, sendEvent } = createRecordingCalls()
    const result = pendingToolCalls.sendClientToolCall(FIRST_CALL, sendEvent)

    vi.advanceTimersByTime(PROMPT_TIME_LIMIT_MS)

    expect(vi.getTimerCount()).toBe(0)
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
