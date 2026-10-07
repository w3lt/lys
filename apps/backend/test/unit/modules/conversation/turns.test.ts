import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as z from "zod"
import StoredConversationTurns from "../../../../src/modules/conversation/turns"
import SqliteConversationRecordReader from "../../../../src/infrastructure/database/conversations/sqliteConversationRecordReader"
import SqliteConversationTurnRecordWriter from "../../../../src/infrastructure/database/conversations/sqliteConversationTurnRecordWriter"
import SqliteDatabase from "../../../../src/infrastructure/database/sqliteDatabase"
import { parseConversationListOptions } from "../../../../src/modules/conversation/listOptions"
import { ConversationNotFoundError } from "../../../../src/utils/errors"
import {
  openConversationTestServices,
  openTestDatabase,
  saveAssistantMessageRow,
  saveConversationRow,
  saveUserMessageRow
} from "../../support/conversationDatabase"
import { createFixtureUuidV7 } from "../../support/conversationFixtures"

/** Wall-clock time observed by every case until it advances the clock. */
const NOW = "2026-03-04T05:06:07.890Z"

/** Wall-clock time after a case advances the clock past {@link NOW}. */
const LATER = "2026-03-04T05:06:09.123Z"

/** Conversation stored before a recovery case creates the turn access. */
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
    agentCode: "lys",
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
 * Creates the turn service over Sqlite records, running its startup recovery.
 *
 * @param database - Migrated test database.
 * @returns The ready turn service.
 */
function createTurns(database: SqliteDatabase): StoredConversationTurns {
  return StoredConversationTurns.create(
    new SqliteConversationTurnRecordWriter(database)
  )
}

/**
 * Reads a stored conversation in its own snapshot.
 *
 * @param database - Migrated test database.
 * @returns The conversation stored under {@link CONVERSATION_ID}.
 */
function findStoredConversation(database: SqliteDatabase) {
  return SqliteConversationRecordReader.create(database).findConversation(
    CONVERSATION_ID
  )
}

describe("StoredConversationTurns", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date(NOW))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe("create", () => {
    it("marks a reply left streaming as interrupted without changing activity time", () => {
      const database = openTestDatabase()
      saveConversationWithReply(database, { status: "streaming" })

      createTurns(database)

      expect(findStoredConversation(database)).toMatchObject({
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
      const database = openTestDatabase()
      saveConversationWithReply(database, reply)

      createTurns(database)

      expect(findStoredConversation(database)?.messages[1]).toMatchObject({
        status: reply.status,
        updatedAt: "2025-01-01T00:00:02.000Z"
      })
    })

    it("refuses a closed database", () => {
      const database = SqliteDatabase.open(":memory:")
      database[Symbol.dispose]()

      expect(() => createTurns(database)).toThrow("Database is closed")
    })
  })

  describe("createConversationTurn", () => {
    it("commits a new conversation with its user and assistant messages", () => {
      const { turns, history } = openConversationTestServices()

      const turn = turns.createConversationTurn({
        userMessageContent: "Hello",
        model: "qwen/qwen3-8b",
        agentCode: "lys"
      })

      // Activity time is maintained by the schema's SQLite-clock trigger,
      // which the test does not control, so only its presence is asserted.
      expect(history.getConversation(turn.conversation.id)).toEqual({
        id: turn.conversation.id,
        title: null,
        agentCode: "lys",
        createdAt: NOW,
        updatedAt: expect.any(String),
        messages: [turn.userMessage, turn.assistantMessage]
      })
    })

    it("leaves no conversation behind when the new turn is invalid", () => {
      const { turns, history } = openConversationTestServices()

      expect(() =>
        turns.createConversationTurn({
          userMessageContent: "",
          model: "qwen/qwen3-8b",
          agentCode: "lys"
        })
      ).toThrow(z.ZodError)

      expect(
        history.listConversations(parseConversationListOptions()).storedCount
      ).toBe(0)
    })

    it("rejects an absent conversation and remains usable for the next turn", () => {
      const { turns, history } = openConversationTestServices()

      expect(() =>
        turns.createConversationTurn({
          conversationId: createFixtureUuidV7(1),
          userMessageContent: "Hello",
          model: "qwen/qwen3-8b",
          agentCode: "lys"
        })
      ).toThrow(ConversationNotFoundError)

      const turn = turns.createConversationTurn({
        userMessageContent: "Hello",
        model: "qwen/qwen3-8b",
        agentCode: "lys"
      })
      expect(
        history.listConversations(parseConversationListOptions()).conversations
      ).toEqual([expect.objectContaining({ id: turn.conversation.id })])
    })
  })

  describe("updateAssistantMessageContent", () => {
    it("appends deltas to a streaming reply in call order", () => {
      const { turns, history } = openConversationTestServices()
      const turn = turns.createConversationTurn({
        userMessageContent: "Hello",
        model: "qwen/qwen3-8b",
        agentCode: "lys"
      })

      expect(
        turns.updateAssistantMessageContent(turn.assistantMessage.id, "Hi")
      ).toBe(true)
      vi.setSystemTime(new Date(LATER))
      expect(
        turns.updateAssistantMessageContent(turn.assistantMessage.id, " there")
      ).toBe(true)

      expect(
        history.getConversation(turn.conversation.id)?.messages[1]
      ).toMatchObject({
        content: "Hi there",
        status: "streaming",
        updatedAt: LATER
      })
    })

    it("returns false for a reply that is already finalized and keeps its text", () => {
      const { turns, history } = openConversationTestServices()
      const turn = turns.createConversationTurn({
        userMessageContent: "Hello",
        model: "qwen/qwen3-8b",
        agentCode: "lys"
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
      const { turns } = openConversationTestServices()

      expect(
        turns.updateAssistantMessageContent(createFixtureUuidV7(9), "Hi")
      ).toBe(false)
    })

    it("rejects an empty delta without changing the reply", () => {
      const { turns, history } = openConversationTestServices()
      const turn = turns.createConversationTurn({
        userMessageContent: "Hello",
        model: "qwen/qwen3-8b",
        agentCode: "lys"
      })

      expect(() =>
        turns.updateAssistantMessageContent(turn.assistantMessage.id, "")
      ).toThrow()

      expect(
        history.getConversation(turn.conversation.id)?.messages[1]
      ).toEqual(turn.assistantMessage)
      expect(
        turns.updateAssistantMessageContent(turn.assistantMessage.id, "Hi")
      ).toBe(true)
    })
  })

  describe("updateAssistantMessageState", () => {
    it("completes a streaming reply with its finish reason", () => {
      const { turns, history } = openConversationTestServices()
      const turn = turns.createConversationTurn({
        userMessageContent: "Hello",
        model: "qwen/qwen3-8b",
        agentCode: "lys"
      })

      vi.setSystemTime(new Date(LATER))

      expect(
        turns.updateAssistantMessageState(turn.assistantMessage.id, {
          status: "completed",
          finishReason: "length"
        })
      ).toBe(true)

      expect(
        history.getConversation(turn.conversation.id)?.messages[1]
      ).toMatchObject({
        status: "completed",
        finishReason: "length",
        updatedAt: LATER
      })
    })

    it.each(["interrupted", "failed"] as const)(
      "stores %s without a finish reason",
      (status) => {
        const { turns, history } = openConversationTestServices()
        const turn = turns.createConversationTurn({
          userMessageContent: "Hello",
          model: "qwen/qwen3-8b",
          agentCode: "lys"
        })
        vi.setSystemTime(new Date(LATER))

        expect(
          turns.updateAssistantMessageState(turn.assistantMessage.id, {
            status
          })
        ).toBe(true)

        expect(
          history.getConversation(turn.conversation.id)?.messages[1]
        ).toMatchObject({ status, finishReason: null, updatedAt: LATER })
      }
    )

    it("finalizes a reply only once", () => {
      const { turns, history } = openConversationTestServices()
      const turn = turns.createConversationTurn({
        userMessageContent: "Hello",
        model: "qwen/qwen3-8b",
        agentCode: "lys"
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
      const { turns } = openConversationTestServices()

      expect(
        turns.updateAssistantMessageState(createFixtureUuidV7(9), {
          status: "failed"
        })
      ).toBe(false)
    })
  })

  describe("updateGeneratedConversationTitle", () => {
    it("saves the trimmed title of an untitled conversation", () => {
      const { turns, history } = openConversationTestServices()
      const turn = turns.createConversationTurn({
        userMessageContent: "Hello",
        model: "qwen/qwen3-8b",
        agentCode: "lys"
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
      const { turns, history, editor } = openConversationTestServices()
      const turn = turns.createConversationTurn({
        userMessageContent: "Hello",
        model: "qwen/qwen3-8b",
        agentCode: "lys"
      })
      editor.updateConversationTitle(turn.conversation.id, "Renamed")

      expect(
        turns.updateGeneratedConversationTitle(turn.conversation.id, "Greeting")
      ).toBeUndefined()

      expect(history.getConversation(turn.conversation.id)?.title).toBe(
        "Renamed"
      )
    })

    it("returns undefined for a conversation that is not stored", () => {
      const { turns } = openConversationTestServices()

      expect(
        turns.updateGeneratedConversationTitle(createFixtureUuidV7(9), "Title")
      ).toBeUndefined()
    })

    it("rejects a blank title without saving it", () => {
      const { turns, history } = openConversationTestServices()
      const turn = turns.createConversationTurn({
        userMessageContent: "Hello",
        model: "qwen/qwen3-8b",
        agentCode: "lys"
      })

      expect(() =>
        turns.updateGeneratedConversationTitle(turn.conversation.id, "   ")
      ).toThrow()

      expect(history.getConversation(turn.conversation.id)?.title).toBeNull()
      expect(
        turns.updateGeneratedConversationTitle(turn.conversation.id, "Title")
      ).toBe("Title")
    })
  })

  it("rejects every operation after the database closes", () => {
    const { database, turns } = openConversationTestServices()
    const turn = turns.createConversationTurn({
      userMessageContent: "Hello",
      model: "qwen/qwen3-8b",
      agentCode: "lys"
    })
    expect(
      turns.updateAssistantMessageContent(turn.assistantMessage.id, "Hi")
    ).toBe(true)
    expect(
      turns.updateAssistantMessageState(turn.assistantMessage.id, {
        status: "failed"
      })
    ).toBe(true)
    expect(
      turns.updateGeneratedConversationTitle(turn.conversation.id, "Title")
    ).toBe("Title")

    database[Symbol.dispose]()

    expect(() =>
      turns.createConversationTurn({
        userMessageContent: "Hello",
        model: "qwen/qwen3-8b",
        agentCode: "lys"
      })
    ).toThrow("Database is closed")
    expect(() =>
      turns.updateAssistantMessageContent(turn.assistantMessage.id, "Hi")
    ).toThrow("Database is closed")
    expect(() =>
      turns.updateAssistantMessageState(turn.assistantMessage.id, {
        status: "failed"
      })
    ).toThrow("Database is closed")
    expect(() =>
      turns.updateGeneratedConversationTitle(turn.conversation.id, "Title")
    ).toThrow("Database is closed")
  })
})
