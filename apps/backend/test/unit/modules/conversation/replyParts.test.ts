import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as z from "zod"
import type { ConversationTestServices } from "../../support/conversationDatabase"
import { openConversationTestServices } from "../../support/conversationDatabase"
import { createFixtureUuidV7 } from "../../support/conversationFixtures"

/** Wall-clock time observed by every case until it advances the clock. */
const NOW = "2026-03-04T05:06:07.890Z"

/** Wall-clock time after a case advances the clock past {@link NOW}. */
const LATER = "2026-03-04T05:06:09.123Z"

/** Identity of the tool call the cases store. */
const TOOL_CALL_ID = createFixtureUuidV7(20)

/**
 * Opens the services and starts one turn whose reply streams.
 *
 * @returns The services, the reply's identity, and its conversation's.
 */
function startTurn(): ConversationTestServices &
  Readonly<{ replyId: string; conversationId: string }> {
  const services = openConversationTestServices()
  const turn = services.turns.createConversationTurn({
    conversation: { kind: "new", agentCode: "lys" },
    userMessageContent: "Hello",
    model: "qwen/qwen3-8b"
  })
  return {
    ...services,
    replyId: turn.assistantMessage.id,
    conversationId: turn.conversation.id
  }
}

/**
 * Reads the parts of a turn's reply.
 *
 * @param turn - Started turn.
 * @returns The reply's stored parts.
 */
function readParts(turn: ReturnType<typeof startTurn>) {
  const reply = turn.history.getConversation(turn.conversationId)?.messages[1]
  return reply?.role === "assistant" ? reply.parts : undefined
}

describe("StoredReplyParts", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date(NOW))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe("createReplyPart", () => {
    it.each(["reasoning", "text"] as const)(
      "stores a %s part under a new UUIDv7 at the current time",
      (kind) => {
        const turn = startTurn()

        const part = turn.replyParts.createReplyPart(turn.replyId, {
          kind,
          round: 2,
          content: "Moths"
        })

        expect(part).toEqual({
          kind,
          id: expect.any(String),
          round: 2,
          createdAt: NOW,
          updatedAt: NOW,
          content: "Moths"
        })
        expect(z.uuidv7().safeParse(part?.id).success).toBe(true)
        expect(readParts(turn)).toEqual([part])
      }
    )

    it("stores a tool call under its own identity without sources", () => {
      const turn = startTurn()

      const part = turn.replyParts.createReplyPart(turn.replyId, {
        kind: "tool-call",
        id: TOOL_CALL_ID,
        round: 0,
        toolName: "web_search",
        argumentText: '{"query":"moths"}',
        status: "awaiting-approval"
      })

      expect(part).toEqual({
        kind: "tool-call",
        id: TOOL_CALL_ID,
        round: 0,
        toolName: "web_search",
        argumentText: '{"query":"moths"}',
        status: "awaiting-approval",
        createdAt: NOW,
        updatedAt: NOW
      })
      expect(readParts(turn)).toEqual([part])
    })

    it("stores a call that cannot run with its explanation", () => {
      const turn = startTurn()

      expect(
        turn.replyParts.createReplyPart(turn.replyId, {
          kind: "tool-call",
          id: TOOL_CALL_ID,
          round: 0,
          toolName: "nope",
          argumentText: "{",
          status: "failed",
          result: "No tool is named nope."
        })
      ).toMatchObject({ status: "failed", result: "No tool is named nope." })
    })

    it.each([
      ["empty text", { kind: "text", round: 0, content: "" } as const],
      ["a negative round", { kind: "text", round: -1, content: "x" } as const],
      [
        "a failure without an explanation",
        {
          kind: "tool-call",
          id: TOOL_CALL_ID,
          round: 0,
          toolName: "nope",
          argumentText: "{}",
          status: "failed",
          result: ""
        } as const
      ]
    ])("rejects %s without storing anything", (_label, draft) => {
      const turn = startTurn()

      expect(() =>
        turn.replyParts.createReplyPart(turn.replyId, draft)
      ).toThrow(z.ZodError)
      expect(readParts(turn)).toEqual([])
    })

    it("returns undefined for a finalized reply", () => {
      const turn = startTurn()
      turn.turns.updateAssistantMessageState(turn.replyId, {
        status: "interrupted"
      })

      expect(
        turn.replyParts.createReplyPart(turn.replyId, {
          kind: "text",
          round: 0,
          content: "Late"
        })
      ).toBeUndefined()
      expect(readParts(turn)).toEqual([])
    })
  })

  describe("updateReplyPartContent", () => {
    it("appends fragments in call order and returns each update time", () => {
      const turn = startTurn()
      const part = turn.replyParts.createReplyPart(turn.replyId, {
        kind: "text",
        round: 0,
        content: "Hi"
      })
      if (part === undefined) throw new Error("Expected a stored part")
      vi.setSystemTime(new Date(LATER))

      expect(
        turn.replyParts.updateReplyPartContent(turn.replyId, part.id, " there")
      ).toBe(LATER)

      expect(readParts(turn)).toEqual([
        { ...part, content: "Hi there", updatedAt: LATER }
      ])
    })

    it("rejects an empty fragment without changing the part", () => {
      const turn = startTurn()
      const part = turn.replyParts.createReplyPart(turn.replyId, {
        kind: "text",
        round: 0,
        content: "Hi"
      })
      if (part === undefined) throw new Error("Expected a stored part")

      expect(() =>
        turn.replyParts.updateReplyPartContent(turn.replyId, part.id, "")
      ).toThrow("Reply part fragment must not be empty")
      expect(readParts(turn)).toEqual([part])
    })

    it("returns undefined for a finalized reply and keeps the part", () => {
      const turn = startTurn()
      const part = turn.replyParts.createReplyPart(turn.replyId, {
        kind: "text",
        round: 0,
        content: "Hi"
      })
      if (part === undefined) throw new Error("Expected a stored part")
      turn.turns.updateAssistantMessageState(turn.replyId, {
        status: "interrupted"
      })

      expect(
        turn.replyParts.updateReplyPartContent(turn.replyId, part.id, " late")
      ).toBeUndefined()
      expect(readParts(turn)).toEqual([part])
    })
  })

  describe("updateReplyToolCall", () => {
    it("stores each change at the current time and returns the stored call", () => {
      const turn = startTurn()
      turn.replyParts.createReplyPart(turn.replyId, {
        kind: "tool-call",
        id: TOOL_CALL_ID,
        round: 0,
        toolName: "web_search",
        argumentText: '{"query":"moths"}',
        status: "awaiting-approval"
      })
      vi.setSystemTime(new Date(LATER))

      expect(
        turn.replyParts.updateReplyToolCall(turn.replyId, TOOL_CALL_ID, {
          status: "running"
        })
      ).toMatchObject({ status: "running", updatedAt: LATER })
      const succeeded = turn.replyParts.updateReplyToolCall(
        turn.replyId,
        TOOL_CALL_ID,
        {
          status: "succeeded",
          result: "Results",
          sources: [
            { number: 1, url: "https://moths.example/", title: "Moths" }
          ]
        }
      )

      expect(succeeded).toMatchObject({
        status: "succeeded",
        result: "Results",
        sourceNumbers: [1],
        updatedAt: LATER
      })
      expect(readParts(turn)).toEqual([succeeded])
      expect(
        turn.history.getConversation(turn.conversationId)?.sources
      ).toEqual([{ number: 1, url: "https://moths.example/", title: "Moths" }])
    })

    it("returns undefined for a call that is not stored", () => {
      const turn = startTurn()

      expect(
        turn.replyParts.updateReplyToolCall(turn.replyId, TOOL_CALL_ID, {
          status: "running"
        })
      ).toBeUndefined()
    })
  })

  it("rejects every operation after the database closes", () => {
    const turn = startTurn()
    turn.database[Symbol.dispose]()

    expect(() =>
      turn.replyParts.createReplyPart(turn.replyId, {
        kind: "text",
        round: 0,
        content: "Hi"
      })
    ).toThrow("Database is closed")
    expect(() =>
      turn.replyParts.updateReplyPartContent(turn.replyId, TOOL_CALL_ID, "Hi")
    ).toThrow("Database is closed")
    expect(() =>
      turn.replyParts.updateReplyToolCall(turn.replyId, TOOL_CALL_ID, {
        status: "running"
      })
    ).toThrow("Database is closed")
  })
})
