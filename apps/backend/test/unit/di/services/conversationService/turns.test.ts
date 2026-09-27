import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi
} from "vitest"
import * as z from "zod"
import SqliteConversationStore from "../../../../../src/di/services/conversationService"
import { parseConversationListOptions } from "../../../../../src/di/services/conversationService/utils"
import { ConversationNotFoundError } from "../../../../../src/utils/errors"
import { createFixtureUuidV7 } from "../../../support/conversationFixtures"

/** Wall-clock time observed by every case. */
const NOW = "2026-03-04T05:06:07.890Z"

/**
 * Opens an isolated in-memory store owned by the current test.
 *
 * @returns The store with its turn and history access.
 */
function openStore() {
  const store = SqliteConversationStore.open(":memory:")
  onTestFinished(() => {
    store[Symbol.dispose]()
  })
  return {
    store,
    turns: store.createTurnAccess(),
    history: store.createHistoryAccess()
  }
}

describe("SqliteConversationTurns", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date(NOW))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe("createConversationTurn", () => {
    it("commits a new conversation with its user and assistant messages", () => {
      const { turns, history } = openStore()

      const turn = turns.createConversationTurn({
        userMessageContent: "Hello",
        model: "qwen/qwen3-8b",
        systemPrompt: "You are Lys."
      })

      // Activity time is maintained by the schema's SQLite-clock trigger,
      // which the test does not control, so only its presence is asserted.
      expect(history.getConversation(turn.conversation.id)).toEqual({
        id: turn.conversation.id,
        title: null,
        systemPrompt: "You are Lys.",
        createdAt: NOW,
        updatedAt: expect.any(String),
        messages: [turn.userMessage, turn.assistantMessage]
      })
    })

    it("leaves no conversation behind when the new turn is invalid", () => {
      const { turns, history } = openStore()

      expect(() =>
        turns.createConversationTurn({
          userMessageContent: "",
          model: "qwen/qwen3-8b",
          systemPrompt: "You are Lys."
        })
      ).toThrow(z.ZodError)

      expect(
        history.listConversations(parseConversationListOptions()).storedCount
      ).toBe(0)
    })

    it("rejects an absent conversation and remains usable for the next turn", () => {
      const { turns, history } = openStore()

      expect(() =>
        turns.createConversationTurn({
          conversationId: createFixtureUuidV7(1),
          userMessageContent: "Hello",
          model: "qwen/qwen3-8b",
          systemPrompt: "You are Lys."
        })
      ).toThrow(ConversationNotFoundError)

      const turn = turns.createConversationTurn({
        userMessageContent: "Hello",
        model: "qwen/qwen3-8b",
        systemPrompt: "You are Lys."
      })
      expect(
        history.listConversations(parseConversationListOptions()).conversations
      ).toEqual([expect.objectContaining({ id: turn.conversation.id })])
    })
  })

  describe("updateAssistantMessageContent", () => {
    it("appends deltas to a streaming reply in call order", () => {
      const { turns, history } = openStore()
      const turn = turns.createConversationTurn({
        userMessageContent: "Hello",
        model: "qwen/qwen3-8b",
        systemPrompt: "You are Lys."
      })

      expect(
        turns.updateAssistantMessageContent(turn.assistantMessage.id, "Hi")
      ).toBe(true)
      expect(
        turns.updateAssistantMessageContent(turn.assistantMessage.id, " there")
      ).toBe(true)

      expect(
        history.getConversation(turn.conversation.id)?.messages[1]
      ).toMatchObject({ content: "Hi there", status: "streaming" })
    })

    it("returns false for a reply that is already finalized and keeps its text", () => {
      const { turns, history } = openStore()
      const turn = turns.createConversationTurn({
        userMessageContent: "Hello",
        model: "qwen/qwen3-8b",
        systemPrompt: "You are Lys."
      })
      turns.updateAssistantMessageContent(turn.assistantMessage.id, "Hi")
      turns.updateAssistantMessageState(turn.assistantMessage.id, {
        status: "interrupted"
      })

      expect(
        turns.updateAssistantMessageContent(turn.assistantMessage.id, " late")
      ).toBe(false)

      expect(
        history.getConversation(turn.conversation.id)?.messages[1]?.content
      ).toBe("Hi")
    })

    it("returns false for a reply that is not stored", () => {
      const { turns } = openStore()

      expect(
        turns.updateAssistantMessageContent(createFixtureUuidV7(9), "Hi")
      ).toBe(false)
    })

    it("rejects an empty delta without changing the reply", () => {
      const { turns, history } = openStore()
      const turn = turns.createConversationTurn({
        userMessageContent: "Hello",
        model: "qwen/qwen3-8b",
        systemPrompt: "You are Lys."
      })

      expect(() =>
        turns.updateAssistantMessageContent(turn.assistantMessage.id, "")
      ).toThrow("Assistant delta must not be empty")

      expect(
        history.getConversation(turn.conversation.id)?.messages[1]
      ).toEqual(turn.assistantMessage)
    })
  })

  describe("updateAssistantMessageState", () => {
    it("completes a streaming reply with its finish reason", () => {
      const { turns, history } = openStore()
      const turn = turns.createConversationTurn({
        userMessageContent: "Hello",
        model: "qwen/qwen3-8b",
        systemPrompt: "You are Lys."
      })

      expect(
        turns.updateAssistantMessageState(turn.assistantMessage.id, {
          status: "completed",
          finishReason: "length"
        })
      ).toBe(true)

      expect(
        history.getConversation(turn.conversation.id)?.messages[1]
      ).toMatchObject({ status: "completed", finishReason: "length" })
    })

    it.each(["interrupted", "failed"] as const)(
      "stores %s without a finish reason",
      (status) => {
        const { turns, history } = openStore()
        const turn = turns.createConversationTurn({
          userMessageContent: "Hello",
          model: "qwen/qwen3-8b",
          systemPrompt: "You are Lys."
        })

        expect(
          turns.updateAssistantMessageState(turn.assistantMessage.id, {
            status
          })
        ).toBe(true)

        expect(
          history.getConversation(turn.conversation.id)?.messages[1]
        ).toMatchObject({ status, finishReason: null })
      }
    )

    it("finalizes a reply only once", () => {
      const { turns, history } = openStore()
      const turn = turns.createConversationTurn({
        userMessageContent: "Hello",
        model: "qwen/qwen3-8b",
        systemPrompt: "You are Lys."
      })
      turns.updateAssistantMessageState(turn.assistantMessage.id, {
        status: "completed",
        finishReason: "stop"
      })

      expect(
        turns.updateAssistantMessageState(turn.assistantMessage.id, {
          status: "failed"
        })
      ).toBe(false)

      expect(
        history.getConversation(turn.conversation.id)?.messages[1]
      ).toMatchObject({ status: "completed", finishReason: "stop" })
    })

    it("returns false for a reply that is not stored", () => {
      const { turns } = openStore()

      expect(
        turns.updateAssistantMessageState(createFixtureUuidV7(9), {
          status: "failed"
        })
      ).toBe(false)
    })
  })

  describe("updateGeneratedConversationTitle", () => {
    it("saves the trimmed title of an untitled conversation", () => {
      const { turns, history } = openStore()
      const turn = turns.createConversationTurn({
        userMessageContent: "Hello",
        model: "qwen/qwen3-8b",
        systemPrompt: "You are Lys."
      })

      expect(
        turns.updateGeneratedConversationTitle(
          turn.conversation.id,
          "  Greeting  "
        )
      ).toBe("Greeting")

      expect(history.getConversation(turn.conversation.id)?.title).toBe(
        "Greeting"
      )
    })

    it("keeps an existing title and returns undefined", () => {
      const { turns, history } = openStore()
      const turn = turns.createConversationTurn({
        userMessageContent: "Hello",
        model: "qwen/qwen3-8b",
        systemPrompt: "You are Lys."
      })
      history.updateConversationTitle(turn.conversation.id, "Renamed")

      expect(
        turns.updateGeneratedConversationTitle(turn.conversation.id, "Greeting")
      ).toBeUndefined()

      expect(history.getConversation(turn.conversation.id)?.title).toBe(
        "Renamed"
      )
    })

    it("returns undefined for a conversation that is not stored", () => {
      const { turns } = openStore()

      expect(
        turns.updateGeneratedConversationTitle(createFixtureUuidV7(9), "Title")
      ).toBeUndefined()
    })

    it("rejects a blank title without saving it", () => {
      const { turns, history } = openStore()
      const turn = turns.createConversationTurn({
        userMessageContent: "Hello",
        model: "qwen/qwen3-8b",
        systemPrompt: "You are Lys."
      })

      expect(() =>
        turns.updateGeneratedConversationTitle(turn.conversation.id, "   ")
      ).toThrow("Generated title must not be empty")

      expect(history.getConversation(turn.conversation.id)?.title).toBeNull()
    })
  })

  it("rejects every operation after the store is disposed", () => {
    const { store, turns } = openStore()
    const turn = turns.createConversationTurn({
      userMessageContent: "Hello",
      model: "qwen/qwen3-8b",
      systemPrompt: "You are Lys."
    })

    store[Symbol.dispose]()

    const closed = "Conversation store is closed"
    expect(() =>
      turns.createConversationTurn({
        userMessageContent: "Hello",
        model: "qwen/qwen3-8b",
        systemPrompt: "You are Lys."
      })
    ).toThrow(closed)
    expect(() =>
      turns.updateAssistantMessageContent(turn.assistantMessage.id, "Hi")
    ).toThrow(closed)
    expect(() =>
      turns.updateAssistantMessageState(turn.assistantMessage.id, {
        status: "failed"
      })
    ).toThrow(closed)
    expect(() =>
      turns.updateGeneratedConversationTitle(turn.conversation.id, "Title")
    ).toThrow(closed)
  })
})
