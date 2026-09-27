import { describe, expect, it } from "vitest"
import * as z from "zod"
import {
  getConversation,
  getConversationMetadata
} from "../../../../src/di/services/conversationService/readConversation"
import {
  insertAssistantMessageRow,
  insertConversationRow,
  insertUserMessageRow,
  openConversationTestDatabase
} from "../../../support/conversationDatabase"
import { createFixtureUuidV7 } from "../../../support/conversationFixtures"

/** Stored conversation read by the cases. */
const CONVERSATION_ID = createFixtureUuidV7(1)

describe("getConversationMetadata", () => {
  it("returns the stored metadata without the transcript", () => {
    const database = openConversationTestDatabase()
    insertConversationRow(database, {
      id: CONVERSATION_ID,
      title: "Trip plan",
      systemPrompt: "You are Lys.",
      createdAt: "2025-01-01T00:00:00.000Z"
    })

    expect(getConversationMetadata(database, CONVERSATION_ID)).toEqual({
      id: CONVERSATION_ID,
      title: "Trip plan",
      systemPrompt: "You are Lys.",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z"
    })
  })

  it("returns undefined for an absent conversation", () => {
    const database = openConversationTestDatabase()

    expect(getConversationMetadata(database, CONVERSATION_ID)).toBeUndefined()
  })

  it("rejects stored metadata that violates the conversation contract", () => {
    const database = openConversationTestDatabase()
    insertConversationRow(database, {
      id: CONVERSATION_ID,
      title: "",
      systemPrompt: "You are Lys.",
      createdAt: "2025-01-01T00:00:00.000Z"
    })

    expect(() => getConversationMetadata(database, CONVERSATION_ID)).toThrow(
      z.ZodError
    )
  })
})

describe("getConversation", () => {
  it("returns undefined for an absent conversation", () => {
    const database = openConversationTestDatabase()

    expect(getConversation(database, CONVERSATION_ID)).toBeUndefined()
  })

  it("returns an empty transcript for a conversation without messages", () => {
    const database = openConversationTestDatabase()
    insertConversationRow(database, {
      id: CONVERSATION_ID,
      title: null,
      systemPrompt: "You are Lys.",
      createdAt: "2025-01-01T00:00:00.000Z"
    })

    expect(getConversation(database, CONVERSATION_ID)).toMatchObject({
      id: CONVERSATION_ID,
      title: null,
      messages: []
    })
  })

  it("projects each role's stored columns into the message contract", () => {
    const database = openConversationTestDatabase()
    insertConversationRow(database, {
      id: CONVERSATION_ID,
      title: null,
      systemPrompt: "You are Lys.",
      createdAt: "2025-01-01T00:00:00.000Z"
    })
    insertUserMessageRow(database, {
      id: createFixtureUuidV7(10),
      conversationId: CONVERSATION_ID,
      content: "Hello",
      createdAt: "2025-01-01T00:00:01.000Z"
    })
    insertAssistantMessageRow(database, {
      id: createFixtureUuidV7(11),
      conversationId: CONVERSATION_ID,
      model: "qwen/qwen3-8b",
      content: "Hi there",
      status: "completed",
      finishReason: "stop",
      createdAt: "2025-01-01T00:00:02.000Z",
      updatedAt: "2025-01-01T00:00:03.000Z"
    })

    expect(getConversation(database, CONVERSATION_ID)?.messages).toEqual([
      {
        id: createFixtureUuidV7(10),
        role: "user",
        content: "Hello",
        createdAt: "2025-01-01T00:00:01.000Z"
      },
      {
        id: createFixtureUuidV7(11),
        role: "assistant",
        model: "qwen/qwen3-8b",
        content: "Hi there",
        status: "completed",
        finishReason: "stop",
        createdAt: "2025-01-01T00:00:02.000Z",
        updatedAt: "2025-01-01T00:00:03.000Z"
      }
    ])
  })

  it("orders the transcript by creation time and then by identity", () => {
    const database = openConversationTestDatabase()
    insertConversationRow(database, {
      id: CONVERSATION_ID,
      title: null,
      systemPrompt: "You are Lys.",
      createdAt: "2025-01-01T00:00:00.000Z"
    })
    insertUserMessageRow(database, {
      id: createFixtureUuidV7(30),
      conversationId: CONVERSATION_ID,
      content: "later identity, same time",
      createdAt: "2025-01-01T00:00:01.000Z"
    })
    insertUserMessageRow(database, {
      id: createFixtureUuidV7(20),
      conversationId: CONVERSATION_ID,
      content: "earlier identity, same time",
      createdAt: "2025-01-01T00:00:01.000Z"
    })
    insertUserMessageRow(database, {
      id: createFixtureUuidV7(10),
      conversationId: CONVERSATION_ID,
      content: "latest time",
      createdAt: "2025-01-01T00:00:02.000Z"
    })

    expect(
      getConversation(database, CONVERSATION_ID)?.messages.map(
        ({ content }) => content
      )
    ).toEqual([
      "earlier identity, same time",
      "later identity, same time",
      "latest time"
    ])
  })

  it("reads only the addressed conversation's messages", () => {
    const database = openConversationTestDatabase()
    const otherConversationId = createFixtureUuidV7(2)
    for (const id of [CONVERSATION_ID, otherConversationId]) {
      insertConversationRow(database, {
        id,
        title: null,
        systemPrompt: "You are Lys.",
        createdAt: "2025-01-01T00:00:00.000Z"
      })
    }
    insertUserMessageRow(database, {
      id: createFixtureUuidV7(10),
      conversationId: otherConversationId,
      content: "Other",
      createdAt: "2025-01-01T00:00:01.000Z"
    })

    expect(getConversation(database, CONVERSATION_ID)?.messages).toEqual([])
  })

  it("returns an independent snapshot", () => {
    const database = openConversationTestDatabase()
    insertConversationRow(database, {
      id: CONVERSATION_ID,
      title: null,
      systemPrompt: "You are Lys.",
      createdAt: "2025-01-01T00:00:00.000Z"
    })
    const first = getConversation(database, CONVERSATION_ID)
    first?.messages.push({
      id: createFixtureUuidV7(99),
      role: "user",
      content: "local only",
      createdAt: "2025-01-01T00:00:09.000Z"
    })

    expect(getConversation(database, CONVERSATION_ID)?.messages).toEqual([])
  })

  it("rejects a stored message that violates the message contract", () => {
    const database = openConversationTestDatabase()
    insertConversationRow(database, {
      id: CONVERSATION_ID,
      title: null,
      systemPrompt: "You are Lys.",
      createdAt: "2025-01-01T00:00:00.000Z"
    })
    insertUserMessageRow(database, {
      id: "not-a-uuid",
      conversationId: CONVERSATION_ID,
      content: "Hello",
      createdAt: "2025-01-01T00:00:01.000Z"
    })

    expect(() => getConversation(database, CONVERSATION_ID)).toThrow(z.ZodError)
  })
})
