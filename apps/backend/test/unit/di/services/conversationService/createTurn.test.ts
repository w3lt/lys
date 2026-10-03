import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as z from "zod"
import { createConversationTurn } from "../../../../../src/di/services/conversationService/createTurn"
import type { CreateConversationTurnOptions } from "../../../../../src/modules/chat/chat/persistence"
import { ConversationNotFoundError } from "../../../../../src/utils/errors"
import { openSqliteConversationRecords } from "../../../support/conversationDatabase"
import { createFixtureUuidV7 } from "../../../support/conversationFixtures"
import type { ConversationRecordsHarness } from "../../../support/conversationRecordsContract"

/** Wall-clock time observed by every case. */
const NOW = "2026-03-04T05:06:07.890Z"

/** Existing conversation used by continuation cases. */
const EXISTING_CONVERSATION_ID = createFixtureUuidV7(1)

/**
 * Creates a turn inside a turn write, as the turn service does.
 *
 * @param records - Records under test.
 * @param options - Turn selection and content.
 * @param systemPrompt - Prompt for a conversation the turn creates.
 * @returns The created turn after the transaction commits.
 */
function createCommittedTurn(
  records: ConversationRecordsHarness,
  options: CreateConversationTurnOptions,
  systemPrompt: string
) {
  return records.turnRecordWriter.handleConversationTurnWriteRequest(
    (transaction) => createConversationTurn(transaction, options, systemPrompt)
  )
}

/**
 * Stores a titled conversation with one completed exchange before {@link NOW}.
 *
 * @param records - Records under test.
 */
function saveExistingConversation(records: ConversationRecordsHarness): void {
  records.saveConversation({
    id: EXISTING_CONVERSATION_ID,
    title: "Trip plan",
    systemPrompt: "Stored prompt",
    createdAt: "2026-01-01T00:00:00.000Z"
  })
  records.saveUserMessage({
    id: createFixtureUuidV7(10),
    conversationId: EXISTING_CONVERSATION_ID,
    content: "Earlier question",
    createdAt: "2026-01-01T00:00:01.000Z"
  })
  records.saveAssistantMessage({
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
    const records = openSqliteConversationRecords()

    const turn = createCommittedTurn(
      records,
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
    const records = openSqliteConversationRecords()

    const turn = createCommittedTurn(
      records,
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
      records.recordReader.findConversation(turn.conversation.id)?.messages
    ).toEqual([turn.userMessage, turn.assistantMessage])
  })

  it("continues an existing conversation with its stored prompt and prior transcript", () => {
    const records = openSqliteConversationRecords()
    saveExistingConversation(records)

    const turn = createCommittedTurn(
      records,
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
      records.recordReader
        .findConversation(EXISTING_CONVERSATION_ID)
        ?.messages.map(({ content }) => content)
    ).toEqual(["Earlier question", "Earlier answer", "Next question", ""])
  })

  it("interrupts a reply still streaming in the continued conversation and keeps its text", () => {
    const records = openSqliteConversationRecords()
    saveExistingConversation(records)
    records.saveAssistantMessage({
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
      records,
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
    const records = openSqliteConversationRecords()
    saveExistingConversation(records)
    const otherConversationId = createFixtureUuidV7(2)
    records.saveConversation({
      id: otherConversationId,
      title: null,
      systemPrompt: "Other prompt",
      createdAt: "2026-01-01T00:00:00.000Z"
    })
    records.saveAssistantMessage({
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
      records,
      {
        conversationId: EXISTING_CONVERSATION_ID,
        userMessageContent: "Next question",
        model: "qwen/qwen3-8b",
        systemPrompt: "Ignored prompt"
      },
      "Ignored prompt"
    )

    expect(
      records.recordReader.findConversation(otherConversationId)?.messages[0]
    ).toMatchObject({ status: "streaming", content: "Other partial" })
  })

  it("rejects an absent conversation before appending messages", () => {
    const records = openSqliteConversationRecords()

    expect(() =>
      createCommittedTurn(
        records,
        {
          conversationId: EXISTING_CONVERSATION_ID,
          userMessageContent: "Hello",
          model: "qwen/qwen3-8b",
          systemPrompt: "You are Lys."
        },
        "You are Lys."
      )
    ).toThrow(ConversationNotFoundError)

    expect(
      records.recordReader.listConversations("", undefined, 30).storedCount
    ).toBe(0)
  })

  it.each([
    ["empty user content", { userMessageContent: "", model: "qwen/qwen3-8b" }],
    ["an empty model", { userMessageContent: "Hello", model: "" }]
  ])("rejects %s before appending messages", (_label, values) => {
    const records = openSqliteConversationRecords()
    saveExistingConversation(records)

    const messages =
      records.turnRecordWriter.handleConversationTurnWriteRequest(
        (transaction) => {
          expect(() =>
            createConversationTurn(
              transaction,
              {
                conversationId: EXISTING_CONVERSATION_ID,
                systemPrompt: "Ignored prompt",
                ...values
              },
              "Ignored prompt"
            )
          ).toThrow(z.ZodError)
          return transaction.findConversation(EXISTING_CONVERSATION_ID)
            ?.messages
        }
      )

    expect(messages).toHaveLength(2)
  })
})
