import { describe, expect, it } from "vitest"
import * as z from "zod"
import SqliteConversationHistoryReader from "../../../../../src/di/services/conversationService/historyReader"
import { parseConversationListOptions } from "../../../../../src/di/services/conversationService/utils"
import {
  openConversationTestDatabase,
  openConversationTestStore,
  saveConversationRow
} from "../../../support/conversationDatabase"
import { createFixtureUuidV7 } from "../../../support/conversationFixtures"

/**
 * Opens an isolated in-memory store with one committed turn.
 *
 * @returns The test-owned database, turn access, history reader, and the
 * committed turn.
 */
function openStoreWithTurn() {
  const { database, store } = openConversationTestStore()
  const turns = store.createTurnAccess()
  const turn = turns.createConversationTurn({
    userMessageContent: "Hello",
    model: "qwen/qwen3-8b",
    systemPrompt: "You are Lys."
  })
  return { database, turns, history: store.createHistoryReader(), turn }
}

/**
 * Creates a history reader over a test database holding one invalid row.
 *
 * @returns The reader, its database, and the invalid conversation id.
 */
function createHistoryOverInvalidRow() {
  const database = openConversationTestDatabase()
  const conversationId = createFixtureUuidV7(1)
  saveConversationRow(database, {
    id: conversationId,
    title: "",
    systemPrompt: "You are Lys.",
    createdAt: "2025-01-01T00:00:00.000Z"
  })
  return {
    database,
    conversationId,
    history: new SqliteConversationHistoryReader(database)
  }
}

describe("SqliteConversationHistoryReader", () => {
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

      expect(database.handleDatabaseWriteRequest(() => "written")).toBe(
        "written"
      )
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

      expect(database.handleDatabaseWriteRequest(() => "written")).toBe(
        "written"
      )
    })
  })

  it("rejects every operation after the database closes", () => {
    const { database, history, turn } = openStoreWithTurn()
    expect(history.getConversation(turn.conversation.id)).toBeDefined()
    expect(
      history.listConversations(parseConversationListOptions()).storedCount
    ).toBe(1)

    database[Symbol.dispose]()

    expect(() => history.getConversation(turn.conversation.id)).toThrow(
      "Database is closed"
    )
    expect(() =>
      history.listConversations(parseConversationListOptions())
    ).toThrow("Database is closed")
  })
})
