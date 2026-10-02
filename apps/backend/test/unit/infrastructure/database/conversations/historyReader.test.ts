import { describe, expect, it } from "vitest"
import * as z from "zod"
import SqliteConversationHistoryReader from "../../../../../src/infrastructure/database/conversations/historyReader"
import SqliteConversationTurns from "../../../../../src/infrastructure/database/conversations/turns"
import { parseConversationListOptions } from "../../../../../src/modules/conversation/listOptions"
import SqliteDatabase from "../../../../../src/infrastructure/database/sqliteDatabase"
import {
  openConversationTestDatabase,
  openConversationTestServices,
  openTestDatabase,
  saveConversationRow
} from "../../../support/conversationDatabase"
import { createFixtureUuidV7 } from "../../../support/conversationFixtures"

/**
 * Opens isolated in-memory conversation adapters with one committed turn.
 *
 * @returns The test-owned database, turn access, history reader, and the
 * committed turn.
 */
function openHistoryWithTurn() {
  const { database, turns, history } = openConversationTestServices()
  const turn = turns.createConversationTurn({
    userMessageContent: "Hello",
    model: "qwen/qwen3-8b",
    systemPrompt: "You are Lys."
  })
  return { database, turns, history, turn }
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
    history: SqliteConversationHistoryReader.create(database)
  }
}

describe("SqliteConversationHistoryReader", () => {
  describe("create", () => {
    it("registers case-insensitive conversation search for its list queries", () => {
      const database = openTestDatabase()
      SqliteConversationTurns.create(database).createConversationTurn({
        userMessageContent: "Plan the TRIP",
        model: "qwen/qwen3-8b",
        systemPrompt: "You are Lys."
      })

      const history = SqliteConversationHistoryReader.create(database)

      expect(
        history.listConversations(
          parseConversationListOptions({ query: "trip" })
        ).matchCount
      ).toBe(1)
    })

    it("refuses a closed database", () => {
      const database = SqliteDatabase.open(":memory:")
      database[Symbol.dispose]()

      expect(() => SqliteConversationHistoryReader.create(database)).toThrow(
        "Database is closed"
      )
    })
  })

  describe("getConversation", () => {
    it("reads the committed conversation and transcript", () => {
      const { history, turn } = openHistoryWithTurn()

      expect(history.getConversation(turn.conversation.id)).toMatchObject({
        id: turn.conversation.id,
        messages: [turn.userMessage, turn.assistantMessage]
      })
    })

    it("returns undefined for an absent conversation", () => {
      const { history } = openHistoryWithTurn()

      expect(history.getConversation(createFixtureUuidV7(9))).toBeUndefined()
    })

    it("ends its read snapshot so later writes can begin", () => {
      const { history, turns, turn } = openHistoryWithTurn()
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
      const { history, turn } = openHistoryWithTurn()
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
    const { database, history, turn } = openHistoryWithTurn()
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
