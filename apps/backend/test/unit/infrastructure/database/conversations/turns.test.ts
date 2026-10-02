import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
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
import SqliteConversationHistoryReader from "../../../../../src/infrastructure/database/conversations/historyReader"
import SqliteConversationTurns from "../../../../../src/infrastructure/database/conversations/turns"
import { parseConversationListOptions } from "../../../../../src/modules/conversation/listOptions"
import SqliteDatabase from "../../../../../src/infrastructure/database/sqliteDatabase"
import { ConversationNotFoundError } from "../../../../../src/utils/errors"
import {
  openConversationTestServices,
  openTestDatabase,
  saveAssistantMessageRow,
  saveConversationRow,
  saveUserMessageRow
} from "../../../support/conversationDatabase"
import { createFixtureUuidV7 } from "../../../support/conversationFixtures"

/** Wall-clock time observed by every case. */
const NOW = "2026-03-04T05:06:07.890Z"

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

describe("SqliteConversationTurns", () => {
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

      SqliteConversationTurns.create(database)

      expect(
        SqliteConversationHistoryReader.create(database).getConversation(
          CONVERSATION_ID
        )
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
      const database = openTestDatabase()
      saveConversationWithReply(database, reply)

      SqliteConversationTurns.create(database)

      expect(
        SqliteConversationHistoryReader.create(database).getConversation(
          CONVERSATION_ID
        )?.messages[1]
      ).toMatchObject({
        status: reply.status,
        updatedAt: "2025-01-01T00:00:02.000Z"
      })
    })

    it("refuses a closed database", () => {
      const database = SqliteDatabase.open(":memory:")
      database[Symbol.dispose]()

      expect(() => SqliteConversationTurns.create(database)).toThrow(
        "Database is closed"
      )
    })
  })

  describe("createConversationTurn", () => {
    it("commits a new conversation with its user and assistant messages", () => {
      const { turns, history } = openConversationTestServices()

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
      const { turns, history } = openConversationTestServices()

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
      const { turns, history } = openConversationTestServices()

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
      const { turns, history } = openConversationTestServices()
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

    it("commits each delta before returning, visible to another connection", () => {
      const directory = mkdtempSync(join(tmpdir(), "lys-turns-test-"))
      onTestFinished(() => {
        rmSync(directory, { recursive: true, force: true })
      })
      const databaseFilePath = join(directory, "lys_db.sqlite")
      const { turns } = openConversationTestServices(databaseFilePath)
      const turn = turns.createConversationTurn({
        userMessageContent: "Hello",
        model: "qwen/qwen3-8b",
        systemPrompt: "You are Lys."
      })
      const observer = new DatabaseSync(databaseFilePath)
      onTestFinished(() => {
        observer.close()
      })
      const getStoredContent = () =>
        observer
          .prepare("SELECT content FROM conversation_messages WHERE id = ?")
          .get(turn.assistantMessage.id)

      turns.updateAssistantMessageContent(turn.assistantMessage.id, "Hel")
      expect(getStoredContent()).toEqual({ content: "Hel" })

      turns.updateAssistantMessageContent(turn.assistantMessage.id, "lo")
      expect(getStoredContent()).toEqual({ content: "Hello" })
    })

    it("returns false for a reply that is already finalized and keeps its text", () => {
      const { turns, history } = openConversationTestServices()
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
        systemPrompt: "You are Lys."
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
        const { turns, history } = openConversationTestServices()
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
      const { turns, history } = openConversationTestServices()
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
      const { turns, history, editor } = openConversationTestServices()
      const turn = turns.createConversationTurn({
        userMessageContent: "Hello",
        model: "qwen/qwen3-8b",
        systemPrompt: "You are Lys."
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
        systemPrompt: "You are Lys."
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
      systemPrompt: "You are Lys."
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
        systemPrompt: "You are Lys."
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
