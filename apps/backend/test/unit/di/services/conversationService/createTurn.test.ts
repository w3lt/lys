import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as z from "zod"
import { createConversationTurn } from "../../../../../src/di/services/conversationService/createTurn"
import { getConversation } from "../../../../../src/di/services/conversationService/readConversation"
import type { CreateConversationTurnOptions } from "../../../../../src/di/services/conversationService/share"
import type SqliteDatabase from "../../../../../src/infrastructure/database/sqliteDatabase"
import { ConversationNotFoundError } from "../../../../../src/utils/errors"
import {
  saveAssistantMessageRow,
  saveConversationRow,
  saveUserMessageRow,
  openConversationTestDatabase
} from "../../../support/conversationDatabase"
import { createFixtureUuidV7 } from "../../../support/conversationFixtures"

/** Wall-clock time observed by every case. */
const NOW = "2026-03-04T05:06:07.890Z"

/** Existing conversation used by continuation cases. */
const EXISTING_CONVERSATION_ID = createFixtureUuidV7(1)

/**
 * Creates a turn inside a write operation, as the turn writer does.
 *
 * @param database - Migrated test database.
 * @param options - Turn selection and content.
 * @param systemPrompt - Prompt for a conversation the turn creates.
 * @returns The created turn after the transaction commits.
 */
function createCommittedTurn(
  database: SqliteDatabase,
  options: CreateConversationTurnOptions,
  systemPrompt: string
) {
  return database.handleDatabaseWriteRequest((statements) =>
    createConversationTurn(statements, options, systemPrompt)
  )
}

/**
 * Reads a conversation inside a read snapshot, as the history reader does.
 *
 * @param database - Migrated test database.
 * @param conversationId - Conversation to read.
 * @returns The stored conversation, or undefined when absent.
 */
function getStoredConversation(
  database: SqliteDatabase,
  conversationId: string
) {
  return database.handleDatabaseReadRequest((statements) =>
    getConversation(statements, conversationId)
  )
}

/**
 * Stores a titled conversation with one completed exchange before {@link NOW}.
 *
 * @param database - Migrated test database.
 */
function saveExistingConversation(database: SqliteDatabase): void {
  saveConversationRow(database, {
    id: EXISTING_CONVERSATION_ID,
    title: "Trip plan",
    systemPrompt: "Stored prompt",
    createdAt: "2026-01-01T00:00:00.000Z"
  })
  saveUserMessageRow(database, {
    id: createFixtureUuidV7(10),
    conversationId: EXISTING_CONVERSATION_ID,
    content: "Earlier question",
    createdAt: "2026-01-01T00:00:01.000Z"
  })
  saveAssistantMessageRow(database, {
    id: createFixtureUuidV7(11),
    conversationId: EXISTING_CONVERSATION_ID,
    model: "qwen/qwen3-8b",
    content: "Earlier answer",
    status: "completed",
    finishReason: "stop",
    createdAt: "2026-01-01T00:00:02.000Z",
    updatedAt: "2026-01-01T00:00:03.000Z"
  })
}

describe("createConversationTurn", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date(NOW))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("creates an untitled conversation with the prompt argument and an empty snapshot", () => {
    const database = openConversationTestDatabase()

    const turn = createCommittedTurn(
      database,
      {
        userMessageContent: "Hello",
        model: "qwen/qwen3-8b",
        systemPrompt: "Options prompt"
      },
      "Argument prompt"
    )

    expect(turn.isNewConversation).toBe(true)
    expect(turn.conversation).toEqual({
      id: expect.any(String),
      title: null,
      systemPrompt: "Argument prompt",
      createdAt: NOW,
      updatedAt: NOW,
      messages: []
    })
    expect(z.uuidv7().safeParse(turn.conversation.id).success).toBe(true)
  })

  it("appends a user message and an empty streaming reply", () => {
    const database = openConversationTestDatabase()

    const turn = createCommittedTurn(
      database,
      {
        userMessageContent: "Hello",
        model: "qwen/qwen3-8b",
        systemPrompt: "You are Lys."
      },
      "You are Lys."
    )

    expect(turn.userMessage).toEqual({
      id: expect.any(String),
      role: "user",
      content: "Hello",
      createdAt: NOW
    })
    expect(turn.assistantMessage).toEqual({
      id: expect.any(String),
      role: "assistant",
      model: "qwen/qwen3-8b",
      content: "",
      status: "streaming",
      finishReason: null,
      createdAt: NOW,
      updatedAt: NOW
    })
    expect(
      getStoredConversation(database, turn.conversation.id)?.messages
    ).toEqual([turn.userMessage, turn.assistantMessage])
  })

  it("continues an existing conversation with its stored prompt and prior transcript", () => {
    const database = openConversationTestDatabase()
    saveExistingConversation(database)

    const turn = createCommittedTurn(
      database,
      {
        conversationId: EXISTING_CONVERSATION_ID,
        userMessageContent: "Next question",
        model: "qwen/qwen3-8b",
        systemPrompt: "Ignored prompt"
      },
      "Ignored prompt"
    )

    expect(turn.isNewConversation).toBe(false)
    expect(turn.conversation).toMatchObject({
      id: EXISTING_CONVERSATION_ID,
      title: "Trip plan",
      systemPrompt: "Stored prompt"
    })
    expect(turn.conversation.messages.map(({ content }) => content)).toEqual([
      "Earlier question",
      "Earlier answer"
    ])
    expect(
      getStoredConversation(database, EXISTING_CONVERSATION_ID)?.messages.map(
        ({ content }) => content
      )
    ).toEqual(["Earlier question", "Earlier answer", "Next question", ""])
  })

  it("interrupts a reply still streaming in the continued conversation and keeps its text", () => {
    const database = openConversationTestDatabase()
    saveExistingConversation(database)
    saveAssistantMessageRow(database, {
      id: createFixtureUuidV7(12),
      conversationId: EXISTING_CONVERSATION_ID,
      model: "qwen/qwen3-8b",
      content: "Partial",
      status: "streaming",
      finishReason: null,
      createdAt: "2026-01-01T00:00:04.000Z",
      updatedAt: "2026-01-01T00:00:04.000Z"
    })

    const turn = createCommittedTurn(
      database,
      {
        conversationId: EXISTING_CONVERSATION_ID,
        userMessageContent: "Next question",
        model: "qwen/qwen3-8b",
        systemPrompt: "Ignored prompt"
      },
      "Ignored prompt"
    )

    expect(turn.conversation.messages.at(-1)).toMatchObject({
      id: createFixtureUuidV7(12),
      content: "Partial",
      status: "interrupted",
      finishReason: null,
      updatedAt: NOW
    })
  })

  it("does not interrupt a streaming reply in another conversation", () => {
    const database = openConversationTestDatabase()
    saveExistingConversation(database)
    const otherConversationId = createFixtureUuidV7(2)
    saveConversationRow(database, {
      id: otherConversationId,
      title: null,
      systemPrompt: "Other prompt",
      createdAt: "2026-01-01T00:00:00.000Z"
    })
    saveAssistantMessageRow(database, {
      id: createFixtureUuidV7(20),
      conversationId: otherConversationId,
      model: "qwen/qwen3-8b",
      content: "Other partial",
      status: "streaming",
      finishReason: null,
      createdAt: "2026-01-01T00:00:05.000Z",
      updatedAt: "2026-01-01T00:00:05.000Z"
    })

    createCommittedTurn(
      database,
      {
        conversationId: EXISTING_CONVERSATION_ID,
        userMessageContent: "Next question",
        model: "qwen/qwen3-8b",
        systemPrompt: "Ignored prompt"
      },
      "Ignored prompt"
    )

    expect(
      getStoredConversation(database, otherConversationId)?.messages[0]
    ).toMatchObject({ status: "streaming", content: "Other partial" })
  })

  it("rejects an absent conversation without appending messages", () => {
    const database = openConversationTestDatabase()

    const messageCount = database.handleDatabaseWriteRequest((statements) => {
      expect(() =>
        createConversationTurn(
          statements,
          {
            conversationId: EXISTING_CONVERSATION_ID,
            userMessageContent: "Hello",
            model: "qwen/qwen3-8b",
            systemPrompt: "You are Lys."
          },
          "You are Lys."
        )
      ).toThrow(ConversationNotFoundError)
      return statements
        .createStatement("SELECT count(*) AS count FROM conversation_messages")
        .get()
    })

    expect(messageCount).toEqual({ count: 0 })
  })

  it.each([
    ["empty user content", { userMessageContent: "", model: "qwen/qwen3-8b" }],
    ["an empty model", { userMessageContent: "Hello", model: "" }]
  ])("rejects %s before appending messages", (_label, values) => {
    const database = openConversationTestDatabase()
    saveExistingConversation(database)

    const messages = database.handleDatabaseWriteRequest((statements) => {
      expect(() =>
        createConversationTurn(
          statements,
          {
            conversationId: EXISTING_CONVERSATION_ID,
            systemPrompt: "Ignored prompt",
            ...values
          },
          "Ignored prompt"
        )
      ).toThrow(z.ZodError)
      return getConversation(statements, EXISTING_CONVERSATION_ID)?.messages
    })

    expect(messages).toHaveLength(2)
  })
})
