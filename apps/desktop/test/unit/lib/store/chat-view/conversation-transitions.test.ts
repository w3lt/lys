import {
  conversationAssistantMessageSchema,
  conversationSchema
} from "@lys/share"
import { describe, expect, it } from "vitest"
import {
  createStoredChatViewConversation,
  findStreamingReply,
  isCompletedConversationMessage,
  isStreamingConversationAssistantMessage,
  startConversationTurn,
  updateAssistantReplyContent,
  updateAssistantReplyStatus,
  updateAssistantReplyWithSnapshot,
  updateConversationTitle,
  type ChatViewConversation,
  type ReadonlyConversationMessage
} from "@/lib/store/chat-view/conversation-transitions"
import {
  buildCompletedAssistantMessage,
  buildConversation,
  buildConversationMetadata,
  buildEndedAssistantMessage,
  buildStreamingAssistantMessage,
  buildUserMessage,
  createFixtureUuidV7,
  FIXTURE_CONVERSATION_ID
} from "../../../support/conversationFixtures"

/** Time a transition stamps on the message it changes. */
const LATER = "2026-01-02T03:04:06.000Z"

/** Earlier completed turn of the fixture conversation. */
const EARLIER_TURN = [
  buildUserMessage(2, "Hi"),
  buildCompletedAssistantMessage(3, "Hello!")
] as const

/** Reply streaming at the end of the fixture conversation. */
const STREAMING_REPLY = buildStreamingAssistantMessage(5, "Part")

/**
 * Builds a frozen chat-view conversation as the store publishes it.
 *
 * @param messages - Transcript in order.
 * @returns The conversation with the fixture identity and no title.
 */
function buildChatViewConversation(
  messages: readonly ReadonlyConversationMessage[]
): ChatViewConversation {
  return Object.freeze({
    ...buildConversationMetadata(FIXTURE_CONVERSATION_ID, null),
    messages: Object.freeze([...messages])
  })
}

/** Conversation whose last turn is still streaming. */
const STREAMING_CONVERSATION = buildChatViewConversation([
  ...EARLIER_TURN,
  buildUserMessage(4, "Tell me more"),
  STREAMING_REPLY
])

/**
 * Builds a stored conversation from raw message records, validated only by the
 * shared conversation schema as storage reads are.
 *
 * @param messages - Raw stored messages.
 * @returns The schema-valid stored conversation.
 */
function parseStoredConversation(messages: readonly unknown[]) {
  return conversationSchema.parse({
    ...buildConversationMetadata(FIXTURE_CONVERSATION_ID, "Stored"),
    messages
  })
}

describe("isStreamingConversationAssistantMessage", () => {
  it("accepts a streaming reply without a finish reason", () => {
    expect(isStreamingConversationAssistantMessage(STREAMING_REPLY)).toBe(true)
  })

  it.each([
    ["a completed reply", EARLIER_TURN[1]],
    [
      "a streaming reply that claims a finish reason",
      { ...STREAMING_REPLY, finishReason: "stop" }
    ]
  ] as const)("rejects %s", (_label, message) => {
    expect(isStreamingConversationAssistantMessage(message)).toBe(false)
  })
})

describe("isCompletedConversationMessage", () => {
  it.each([
    ["a user message", EARLIER_TURN[0], true],
    ["a terminal reply", EARLIER_TURN[1], true],
    ["a streaming reply", STREAMING_REPLY, false]
  ] as const)("answers %s with %s", (_label, message, isCompleted) => {
    expect(isCompletedConversationMessage(message)).toBe(isCompleted)
  })
})

describe("startConversationTurn", () => {
  it("appends the new turn after the history of the same conversation", () => {
    const previous = buildChatViewConversation(EARLIER_TURN)
    const metadata = buildConversationMetadata(
      FIXTURE_CONVERSATION_ID,
      "Greeting"
    )

    const conversation = startConversationTurn({
      conversationMetadata: metadata,
      previousConversation: previous,
      userMessage: buildUserMessage(4, "Tell me more"),
      assistantMessage: STREAMING_REPLY
    })

    expect(conversation).toEqual({
      ...metadata,
      messages: [
        ...EARLIER_TURN,
        buildUserMessage(4, "Tell me more"),
        STREAMING_REPLY
      ]
    })
    expect(Object.isFrozen(conversation)).toBe(true)
    expect(Object.isFrozen(conversation.messages)).toBe(true)
    expect(previous.messages).toHaveLength(2)
  })

  it("starts a fresh transcript for a different conversation", () => {
    const previous = buildChatViewConversation(EARLIER_TURN)

    const conversation = startConversationTurn({
      conversationMetadata: buildConversationMetadata(
        createFixtureUuidV7(9),
        null
      ),
      previousConversation: previous,
      userMessage: buildUserMessage(10, "New topic"),
      assistantMessage: STREAMING_REPLY
    })

    expect(conversation.messages.map((message) => message.id)).toEqual([
      createFixtureUuidV7(10),
      STREAMING_REPLY.id
    ])
  })
})

describe("updateConversationTitle", () => {
  it("replaces the title and keeps the transcript by identity", () => {
    const conversation = updateConversationTitle(
      STREAMING_CONVERSATION,
      "Greeting"
    )

    expect(conversation.title).toBe("Greeting")
    expect(conversation.messages).toBe(STREAMING_CONVERSATION.messages)
    expect(STREAMING_CONVERSATION.title).toBeNull()
    expect(Object.isFrozen(conversation)).toBe(true)
  })
})

describe("updateAssistantReplyContent", () => {
  it("appends deltas in order and stamps the update time", () => {
    const once = updateAssistantReplyContent(STREAMING_CONVERSATION, {
      assistantMessageId: STREAMING_REPLY.id,
      content: " one",
      timestamp: LATER
    })
    const twice = updateAssistantReplyContent(once, {
      assistantMessageId: STREAMING_REPLY.id,
      content: " two",
      timestamp: LATER
    })

    expect(twice.messages.at(-1)).toEqual({
      ...STREAMING_REPLY,
      content: "Part one two",
      updatedAt: LATER
    })
  })

  it("changes only the addressed reply and leaves the previous conversation intact", () => {
    const conversation = updateAssistantReplyContent(STREAMING_CONVERSATION, {
      assistantMessageId: STREAMING_REPLY.id,
      content: "!",
      timestamp: LATER
    })

    expect(conversation.messages.slice(0, -1)).toEqual(
      STREAMING_CONVERSATION.messages.slice(0, -1)
    )
    expect(conversation.messages[0]).toBe(STREAMING_CONVERSATION.messages[0])
    expect(STREAMING_CONVERSATION.messages.at(-1)).toBe(STREAMING_REPLY)
    expect(Object.isFrozen(conversation.messages.at(-1))).toBe(true)
  })

  it.each([
    ["an absent reply", createFixtureUuidV7(99)],
    ["a user message", createFixtureUuidV7(4)],
    ["a terminal reply", createFixtureUuidV7(3)]
  ])("refuses a delta for %s", (_label, assistantMessageId) => {
    expect(() =>
      updateAssistantReplyContent(STREAMING_CONVERSATION, {
        assistantMessageId,
        content: "x",
        timestamp: LATER
      })
    ).toThrow(assistantMessageId)
  })
})

describe("updateAssistantReplyStatus", () => {
  it("completes the reply with the model's finish reason", () => {
    const conversation = updateAssistantReplyStatus(STREAMING_CONVERSATION, {
      assistantMessageId: STREAMING_REPLY.id,
      status: "completed",
      finishReason: "length",
      timestamp: LATER
    })

    expect(conversation.messages.at(-1)).toEqual({
      ...STREAMING_REPLY,
      status: "completed",
      finishReason: "length",
      updatedAt: LATER
    })
  })

  it.each(["interrupted", "failed"] as const)(
    "ends the reply as %s without a finish reason, keeping its content",
    (status) => {
      const conversation = updateAssistantReplyStatus(STREAMING_CONVERSATION, {
        assistantMessageId: STREAMING_REPLY.id,
        status,
        finishReason: null,
        timestamp: LATER
      })

      expect(conversation.messages.at(-1)).toEqual({
        ...STREAMING_REPLY,
        status,
        finishReason: null,
        updatedAt: LATER
      })
    }
  )

  it("refuses a second terminal transition and later deltas", () => {
    const completed = updateAssistantReplyStatus(STREAMING_CONVERSATION, {
      assistantMessageId: STREAMING_REPLY.id,
      status: "completed",
      finishReason: "stop",
      timestamp: LATER
    })

    expect(() =>
      updateAssistantReplyStatus(completed, {
        assistantMessageId: STREAMING_REPLY.id,
        status: "failed",
        finishReason: null,
        timestamp: LATER
      })
    ).toThrow("terminal")
    expect(() =>
      updateAssistantReplyContent(completed, {
        assistantMessageId: STREAMING_REPLY.id,
        content: "late",
        timestamp: LATER
      })
    ).toThrow("terminal")
  })

  it("refuses a status for an absent reply", () => {
    expect(() =>
      updateAssistantReplyStatus(STREAMING_CONVERSATION, {
        assistantMessageId: createFixtureUuidV7(99),
        status: "interrupted",
        finishReason: null,
        timestamp: LATER
      })
    ).toThrow("not found")
  })
})

describe("createStoredChatViewConversation", () => {
  it("presents a stored conversation in stored order, frozen", () => {
    const stored = buildConversation(
      FIXTURE_CONVERSATION_ID,
      "Stored",
      EARLIER_TURN
    )

    const conversation = createStoredChatViewConversation(stored)

    expect(conversation).toEqual(stored)
    expect(Object.isFrozen(conversation)).toBe(true)
    expect(Object.isFrozen(conversation.messages)).toBe(true)
    expect(
      conversation.messages.every((message) => Object.isFrozen(message))
    ).toBe(true)
  })

  it("keeps a streaming reply that ends the transcript streaming so it can be followed", () => {
    const stored = buildConversation(FIXTURE_CONVERSATION_ID, null, [
      buildUserMessage(4, "Tell me more"),
      STREAMING_REPLY
    ])

    expect(createStoredChatViewConversation(stored).messages.at(-1)).toEqual(
      STREAMING_REPLY
    )
  })

  it("presents an earlier streaming reply as interrupted with its stored content", () => {
    const abandoned = buildStreamingAssistantMessage(3, "Half an ans")
    const stored = buildConversation(FIXTURE_CONVERSATION_ID, null, [
      buildUserMessage(2, "Hi"),
      abandoned,
      buildUserMessage(4, "Still there?")
    ])

    expect(createStoredChatViewConversation(stored).messages[1]).toEqual({
      ...abandoned,
      status: "interrupted",
      finishReason: null
    })
  })

  it.each([
    ["a completed reply without a finish reason", "completed", null],
    ["an interrupted reply with a finish reason", "interrupted", "stop"],
    ["a failed reply with a finish reason", "failed", "length"]
  ])("rejects %s", (_label, status, finishReason) => {
    const stored = parseStoredConversation([
      { ...EARLIER_TURN[1], status, finishReason } satisfies Record<
        string,
        unknown
      >,
      buildUserMessage(4, "Next")
    ])

    expect(() => createStoredChatViewConversation(stored)).toThrow(
      createFixtureUuidV7(3)
    )
  })

  it("keeps interrupted and failed replies as stored, even at the end", () => {
    const interrupted = buildEndedAssistantMessage(3, "Cut", "interrupted")
    const failed = buildEndedAssistantMessage(5, "", "failed")
    const stored = buildConversation(FIXTURE_CONVERSATION_ID, null, [
      buildUserMessage(2, "Hi"),
      interrupted,
      buildUserMessage(4, "Again"),
      failed
    ])

    expect(createStoredChatViewConversation(stored).messages).toEqual([
      buildUserMessage(2, "Hi"),
      interrupted,
      buildUserMessage(4, "Again"),
      failed
    ])
  })

  it("presents an empty transcript", () => {
    const stored = buildConversation(FIXTURE_CONVERSATION_ID, null, [])

    expect(createStoredChatViewConversation(stored).messages).toEqual([])
  })
})

describe("findStreamingReply", () => {
  it("finds the streaming reply that ends the conversation", () => {
    expect(findStreamingReply(STREAMING_CONVERSATION)).toBe(STREAMING_REPLY)
  })

  it.each<[string, readonly ReadonlyConversationMessage[]]>([
    ["a completed last reply", EARLIER_TURN],
    ["an empty transcript", []],
    ["a last user message", [buildUserMessage(2, "Hi")]]
  ])("finds nothing for %s", (_label, messages) => {
    expect(
      findStreamingReply(buildChatViewConversation(messages))
    ).toBeUndefined()
  })
})

describe("updateAssistantReplyWithSnapshot", () => {
  it("replaces the local content with the snapshot's instead of appending", () => {
    const snapshot = buildStreamingAssistantMessage(5, "Partial answer")

    const conversation = updateAssistantReplyWithSnapshot(
      STREAMING_CONVERSATION,
      snapshot
    )

    expect(conversation.messages.at(-1)).toEqual(snapshot)
  })

  it("ends the reply when the snapshot is terminal", () => {
    const snapshot = buildCompletedAssistantMessage(5, "Whole answer")

    const conversation = updateAssistantReplyWithSnapshot(
      STREAMING_CONVERSATION,
      snapshot
    )

    expect(conversation.messages.at(-1)).toEqual(snapshot)
    expect(findStreamingReply(conversation)).toBeUndefined()
  })

  it("refuses a snapshot for a reply that is already terminal locally", () => {
    const snapshot = buildStreamingAssistantMessage(3, "Hello!")

    expect(() =>
      updateAssistantReplyWithSnapshot(STREAMING_CONVERSATION, snapshot)
    ).toThrow("terminal")
  })

  it("refuses a snapshot for an absent reply", () => {
    const snapshot = buildStreamingAssistantMessage(99, "?")

    expect(() =>
      updateAssistantReplyWithSnapshot(STREAMING_CONVERSATION, snapshot)
    ).toThrow("not found")
  })

  it("refuses a final snapshot that breaks the status and finish-reason pairing", () => {
    const snapshot = conversationAssistantMessageSchema.parse({
      ...STREAMING_REPLY,
      status: "completed",
      finishReason: null
    })

    expect(() =>
      updateAssistantReplyWithSnapshot(STREAMING_CONVERSATION, snapshot)
    ).toThrow(STREAMING_REPLY.id)
  })
})
