import { MAXIMUM_CONVERSATION_TITLE_LENGTH } from "@lys/protocol"
import { describe, expect, it, onTestFinished } from "vitest"
import * as z from "zod"
import SqliteConversationStore from "../../../../../src/di/services/conversationService"
import SqliteConversationHistory from "../../../../../src/di/services/conversationService/history"
import { parseConversationListOptions } from "../../../../../src/di/services/conversationService/utils"
import {
  insertConversationRow,
  openConversationTestDatabase
} from "../../../support/conversationDatabase"
import { createFixtureUuidV7 } from "../../../support/conversationFixtures"

/**
 * Opens an isolated in-memory store with one committed turn.
 *
 * @returns The store, its access objects, and the committed turn.
 */
function openStoreWithTurn() {
  const store = SqliteConversationStore.open(":memory:")
  onTestFinished(() => {
    store[Symbol.dispose]()
  })
  const turns = store.createTurnAccess()
  const turn = turns.createConversationTurn({
    userMessageContent: "Hello",
    model: "qwen/qwen3-8b",
    systemPrompt: "You are Lys."
  })
  return { store, turns, history: store.createHistoryAccess(), turn }
}

/**
 * Creates history access over a test database holding one invalid row.
 *
 * @returns The access object, its database, and the invalid conversation id.
 */
function createHistoryOverInvalidRow() {
  const database = openConversationTestDatabase()
  const conversationId = createFixtureUuidV7(1)
  insertConversationRow(database, {
    id: conversationId,
    title: "",
    systemPrompt: "You are Lys.",
    createdAt: "2025-01-01T00:00:00.000Z"
  })
  return {
    database,
    conversationId,
    history: new SqliteConversationHistory(() => database)
  }
}

describe("SqliteConversationHistory", () => {
  describe("getConversation", () => {
    it("reads the committed conversation and transcript", () => {
      const { history, turn } = openStoreWithTurn()

      expect(history.getConversation(turn.conversation.id)).toMatchObject({
        id: turn.conversation.id,
        messages: [turn.userMessage, turn.assistantMessage]
      })
    })

    it("returns undefined for an absent conversation", () => {
      const { history } = openStoreWithTurn()

      expect(history.getConversation(createFixtureUuidV7(9))).toBeUndefined()
    })

    it("ends its read snapshot so later writes can begin", () => {
      const { history, turns, turn } = openStoreWithTurn()
      history.getConversation(turn.conversation.id)

      expect(() =>
        turns.createConversationTurn({
          conversationId: turn.conversation.id,
          userMessageContent: "Again",
          model: "qwen/qwen3-8b",
          systemPrompt: "You are Lys."
        })
      ).not.toThrow()
    })

    it("rejects invalid stored data and ends its read snapshot", () => {
      const { database, conversationId, history } =
        createHistoryOverInvalidRow()

      expect(() => history.getConversation(conversationId)).toThrow(z.ZodError)

      expect(database.isTransaction).toBe(false)
    })
  })

  describe("listConversations", () => {
    it("lists committed conversations", () => {
      const { history, turn } = openStoreWithTurn()
      const stored = history.getConversation(turn.conversation.id)

      expect(history.listConversations(parseConversationListOptions())).toEqual(
        {
          conversations: [
            {
              id: turn.conversation.id,
              title: null,
              createdAt: stored?.createdAt,
              updatedAt: stored?.updatedAt,
              preview: { role: "user", content: "Hello" }
            }
          ],
          storedCount: 1,
          matchCount: 1,
          nextCursor: null
        }
      )
    })

    it("rejects invalid stored data and ends its read snapshot", () => {
      const { database, history } = createHistoryOverInvalidRow()

      expect(() =>
        history.listConversations(parseConversationListOptions())
      ).toThrow(z.ZodError)

      expect(database.isTransaction).toBe(false)
    })
  })

  describe("updateConversationTitle", () => {
    it("stores the trimmed title and returns metadata with unchanged activity time", () => {
      const { history, turn } = openStoreWithTurn()
      const before = history.getConversation(turn.conversation.id)

      const metadata = history.updateConversationTitle(
        turn.conversation.id,
        "  Greeting  "
      )

      expect(metadata).toEqual({
        id: turn.conversation.id,
        title: "Greeting",
        systemPrompt: "You are Lys.",
        createdAt: before?.createdAt,
        updatedAt: before?.updatedAt
      })
      expect(history.getConversation(turn.conversation.id)).toMatchObject({
        title: "Greeting",
        updatedAt: before?.updatedAt,
        messages: before?.messages
      })
    })

    it("accepts a title at the maximum published length", () => {
      const { history, turn } = openStoreWithTurn()
      const title = "t".repeat(MAXIMUM_CONVERSATION_TITLE_LENGTH)

      expect(
        history.updateConversationTitle(turn.conversation.id, title)?.title
      ).toBe(title)
    })

    it("returns undefined for an absent conversation", () => {
      const { history } = openStoreWithTurn()

      expect(
        history.updateConversationTitle(createFixtureUuidV7(9), "Greeting")
      ).toBeUndefined()
    })

    it.each([
      ["a blank title", "   "],
      [
        "a title longer than the published maximum",
        "t".repeat(MAXIMUM_CONVERSATION_TITLE_LENGTH + 1)
      ]
    ])("rejects %s without changing the stored title", (_label, title) => {
      const { history, turn } = openStoreWithTurn()
      history.updateConversationTitle(turn.conversation.id, "Kept")

      expect(() =>
        history.updateConversationTitle(turn.conversation.id, title)
      ).toThrow(z.ZodError)

      expect(history.getConversation(turn.conversation.id)?.title).toBe("Kept")
    })
  })

  describe("deleteConversation", () => {
    it("removes the conversation and reports whether it existed", () => {
      const { history, turn } = openStoreWithTurn()

      expect(history.deleteConversation(turn.conversation.id)).toBe(true)
      expect(history.deleteConversation(turn.conversation.id)).toBe(false)

      expect(history.getConversation(turn.conversation.id)).toBeUndefined()
      expect(
        history.listConversations(parseConversationListOptions()).storedCount
      ).toBe(0)
    })

    it("removes the transcript with the conversation", () => {
      const { history, turns, turn } = openStoreWithTurn()

      history.deleteConversation(turn.conversation.id)

      expect(
        turns.updateAssistantMessageContent(turn.assistantMessage.id, "late")
      ).toBe(false)
    })
  })

  it("rejects every operation after the store is disposed", () => {
    const { store, history, turn } = openStoreWithTurn()

    store[Symbol.dispose]()

    const closed = "Conversation store is closed"
    expect(() => history.getConversation(turn.conversation.id)).toThrow(closed)
    expect(() =>
      history.listConversations(parseConversationListOptions())
    ).toThrow(closed)
    expect(() =>
      history.updateConversationTitle(turn.conversation.id, "Title")
    ).toThrow(closed)
    expect(() => history.deleteConversation(turn.conversation.id)).toThrow(
      closed
    )
  })
})
