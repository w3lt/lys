import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import SqliteConversationStore from "../../../../../src/di/services/conversationService"
import { parseConversationListOptions } from "../../../../../src/di/services/conversationService/utils"
import SqliteDatabase from "../../../../../src/infrastructure/database/sqliteDatabase"
import {
  openConversationTestDatabase,
  openConversationTestStore,
  saveAssistantMessageRow,
  saveConversationRow,
  saveUserMessageRow
} from "../../../support/conversationDatabase"
import { createFixtureUuidV7 } from "../../../support/conversationFixtures"

/** Wall-clock time observed by recovery cases. */
const NOW = "2026-03-04T05:06:07.890Z"

/** Conversation stored before a recovery case creates the store. */
const CONVERSATION_ID = createFixtureUuidV7(1)

/**
 * Stores a conversation whose last activity is a reply in the given state.
 *
 * @param database - Migrated test database.
 * @param reply - Stored state of the reply.
 */
function saveConversationWithReply(
  database: SqliteDatabase,
  reply:
    | Readonly<{ status: "streaming" | "failed" }>
    | Readonly<{ status: "completed"; finishReason: "stop" }>
): void {
  saveConversationRow(database, {
    id: CONVERSATION_ID,
    title: "Trip plan",
    systemPrompt: "You are Lys.",
    createdAt: "2025-01-01T00:00:00.000Z"
  })
  saveUserMessageRow(database, {
    id: createFixtureUuidV7(10),
    conversationId: CONVERSATION_ID,
    content: "Hello",
    createdAt: "2025-01-01T00:00:01.000Z"
  })
  saveAssistantMessageRow(database, {
    id: createFixtureUuidV7(11),
    conversationId: CONVERSATION_ID,
    model: "qwen/qwen3-8b",
    content: "Partial",
    finishReason: null,
    ...reply,
    createdAt: "2025-01-01T00:00:02.000Z",
    updatedAt: "2025-01-01T00:00:02.000Z"
  })
}

/**
 * Creates a store over an existing test database.
 *
 * @param database - Migrated test database.
 * @returns The ready store.
 */
function createStore(database: SqliteDatabase): SqliteConversationStore {
  return SqliteConversationStore.create({
    databaseReader: database,
    databaseWriter: database,
    databaseFunctionRegistry: database
  })
}

describe("SqliteConversationStore", () => {
  it("creates turn access and a history reader that share one database", () => {
    const { store } = openConversationTestStore()

    const turn = store.createTurnAccess().createConversationTurn({
      userMessageContent: "Hello",
      model: "qwen/qwen3-8b",
      systemPrompt: "You are Lys."
    })

    expect(
      store.createHistoryReader().getConversation(turn.conversation.id)
    ).toMatchObject({ id: turn.conversation.id, systemPrompt: "You are Lys." })
  })

  it("isolates stores over separate databases", () => {
    const first = openConversationTestStore().store
    const second = openConversationTestStore().store

    first.createTurnAccess().createConversationTurn({
      userMessageContent: "Hello",
      model: "qwen/qwen3-8b",
      systemPrompt: "You are Lys."
    })

    expect(
      second
        .createHistoryReader()
        .listConversations(parseConversationListOptions()).storedCount
    ).toBe(0)
  })

  it("provides case-insensitive search to history queries", () => {
    const { store } = openConversationTestStore()
    store.createTurnAccess().createConversationTurn({
      userMessageContent: "Plan the TRIP",
      model: "qwen/qwen3-8b",
      systemPrompt: "You are Lys."
    })

    expect(
      store
        .createHistoryReader()
        .listConversations(parseConversationListOptions({ query: "trip" }))
        .matchCount
    ).toBe(1)
  })

  describe("create", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] })
      vi.setSystemTime(new Date(NOW))
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it("marks a reply left streaming as interrupted without changing activity time", () => {
      const database = openConversationTestDatabase()
      saveConversationWithReply(database, { status: "streaming" })

      const store = createStore(database)

      expect(
        store.createHistoryReader().getConversation(CONVERSATION_ID)
      ).toMatchObject({
        updatedAt: "2025-01-01T00:00:02.000Z",
        messages: [
          { content: "Hello" },
          {
            id: createFixtureUuidV7(11),
            content: "Partial",
            status: "interrupted",
            finishReason: null,
            updatedAt: NOW
          }
        ]
      })
    })

    it.each([
      { status: "completed", finishReason: "stop" } as const,
      { status: "failed" } as const
    ])("leaves a $status reply unchanged", (reply) => {
      const database = openConversationTestDatabase()
      saveConversationWithReply(database, reply)

      const store = createStore(database)

      expect(
        store.createHistoryReader().getConversation(CONVERSATION_ID)
          ?.messages[1]
      ).toMatchObject({
        status: reply.status,
        updatedAt: "2025-01-01T00:00:02.000Z"
      })
    })

    it("refuses a closed database", () => {
      const database = SqliteDatabase.open(":memory:")
      database[Symbol.dispose]()

      expect(() => createStore(database)).toThrow("Database is closed")
    })
  })

  it("fails every access operation with Database is closed after the database closes", () => {
    const { database, store } = openConversationTestStore()
    const history = store.createHistoryReader()
    const editor = store.createHistoryEditor()
    const turns = store.createTurnAccess()

    database[Symbol.dispose]()

    expect(() =>
      history.listConversations(parseConversationListOptions())
    ).toThrow("Database is closed")
    expect(() => editor.deleteConversation(CONVERSATION_ID)).toThrow(
      "Database is closed"
    )
    expect(() =>
      turns.createConversationTurn({
        userMessageContent: "Hello",
        model: "qwen/qwen3-8b",
        systemPrompt: "You are Lys."
      })
    ).toThrow("Database is closed")
  })

  it("creates access after the database closes whose operations fail with Database is closed", () => {
    const { database, store } = openConversationTestStore()

    database[Symbol.dispose]()

    const lateTurns = store.createTurnAccess()
    expect(() =>
      lateTurns.updateAssistantMessageContent(createFixtureUuidV7(9), "Hi")
    ).toThrow("Database is closed")
  })
})
