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
  updateAssistantReplyPart,
  updateAssistantReplyPartContent,
  updateAssistantReplyStatus,
  updateAssistantReplyWithSnapshot,
  updateConversationSources,
  updateConversationTitle,
  type ChatViewConversation,
  type ReadonlyConversationMessage
} from "@/lib/store/chat-view/conversation-transitions"
import { buildChatViewReplyPart } from "@/lib/store/chat-view/reply-parts"
import {
  buildChatViewAssistantMessage,
  buildCompletedAssistantMessage,
  buildConversation,
  buildConversationMetadata,
  buildConversationWithSources,
  buildEndedAssistantMessage,
  buildTextPart,
  buildStreamingAssistantMessage,
  buildStreamingChatViewReply,
  buildToolCallPart,
  buildUserMessage,
  createFixtureUuidV7,
  FIXTURE_CONVERSATION_ID
} from "../../../support/conversationFixtures"

/** Time a transition stamps on the message it changes. */
const LATER = "2026-01-02T03:04:06.000Z"

/** Earlier completed reply of the fixture conversation, as stored. */
const STORED_EARLIER_REPLY = buildCompletedAssistantMessage(3, "Hello!")

/** Earlier completed turn of the fixture conversation. */
const EARLIER_TURN = [
  buildUserMessage(2, "Hi"),
  buildChatViewAssistantMessage(STORED_EARLIER_REPLY)
] as const

/** Text part the streaming reply holds. */
const STREAMED_TEXT = buildTextPart(50, 0, "Part")

/** Web search call the streaming reply is running. */
const RUNNING_CALL = buildToolCallPart(51, 0, {
  toolName: "web_search",
  argumentText: '{"query":"moths"}',
  status: "running"
})

/** Reply streaming at the end of the fixture conversation, as stored. */
const STORED_STREAMING_REPLY = buildStreamingAssistantMessage(5, [
  STREAMED_TEXT
])

/** Reply streaming at the end of the fixture conversation. */
const STREAMING_REPLY = buildChatViewAssistantMessage(STORED_STREAMING_REPLY)

/** Source the fixture conversation stored. */
const STORED_SOURCE = Object.freeze({
  number: 1,
  url: "https://moths.example/",
  title: "Moths"
})

/**
 * Builds a frozen chat-view conversation as the store publishes it.
 *
 * @param messages - Transcript in order.
 * @param sources - The conversation's sources; none by default.
 * @returns The conversation with the fixture identity and no title.
 */
function buildChatViewConversation(
  messages: readonly ReadonlyConversationMessage[],
  sources: ChatViewConversation["sources"] = []
): ChatViewConversation {
  return Object.freeze({
    ...buildConversationMetadata(FIXTURE_CONVERSATION_ID, null),
    messages: Object.freeze([...messages]),
    sources: Object.freeze([...sources])
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
    messages,
    sources: []
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
  it("appends the new turn after the history of the same conversation and keeps its sources", () => {
    const previous = buildChatViewConversation(EARLIER_TURN, [STORED_SOURCE])
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
      ],
      sources: [STORED_SOURCE]
    })
    expect(Object.isFrozen(conversation)).toBe(true)
    expect(Object.isFrozen(conversation.messages)).toBe(true)
    expect(previous.messages).toHaveLength(2)
  })

  it("keeps the files sent with the user message", () => {
    const userMessage = buildUserMessage(4, "Read the notes", [
      { kind: "text", number: 1, name: "notes.md", sizeBytes: 18 }
    ])

    const conversation = startConversationTurn({
      conversationMetadata: buildConversationMetadata(
        FIXTURE_CONVERSATION_ID,
        "Greeting"
      ),
      previousConversation: buildChatViewConversation(EARLIER_TURN, []),
      userMessage,
      assistantMessage: STREAMING_REPLY
    })

    expect(conversation.messages.at(-2)).toEqual(userMessage)
  })

  it("starts a fresh transcript without sources for a different conversation", () => {
    const previous = buildChatViewConversation(EARLIER_TURN, [STORED_SOURCE])

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
    expect(conversation.sources).toEqual([])
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

describe("updateAssistantReplyPart", () => {
  it("adds a new part after the reply's earlier parts and keeps the reply's update time", () => {
    const conversation = updateAssistantReplyPart(STREAMING_CONVERSATION, {
      assistantMessageId: STREAMING_REPLY.id,
      part: RUNNING_CALL
    })

    expect(conversation.messages.at(-1)).toEqual({
      ...STREAMING_REPLY,
      parts: [STREAMED_TEXT, buildChatViewReplyPart(RUNNING_CALL)]
    })
    expect(Object.isFrozen(conversation.messages.at(-1))).toBe(true)
  })

  it("replaces the part stored under the same identifier in place, before the parts that follow it", () => {
    const laterCall = buildToolCallPart(52, 0, {
      toolName: "read_page",
      argumentText: '{"url":"https://moths.example/"}',
      status: "running"
    })
    const withCall = updateAssistantReplyPart(
      updateAssistantReplyPart(STREAMING_CONVERSATION, {
        assistantMessageId: STREAMING_REPLY.id,
        part: RUNNING_CALL
      }),
      { assistantMessageId: STREAMING_REPLY.id, part: laterCall }
    )
    const succeeded = buildToolCallPart(51, 0, {
      toolName: "web_search",
      argumentText: '{"query":"moths"}',
      status: "succeeded",
      result: "Results",
      sourceNumbers: [1]
    })

    const conversation = updateAssistantReplyPart(withCall, {
      assistantMessageId: STREAMING_REPLY.id,
      part: succeeded
    })

    const reply = conversation.messages.at(-1)
    expect(reply?.role === "assistant" && reply.parts).toEqual([
      STREAMED_TEXT,
      buildChatViewReplyPart(succeeded),
      buildChatViewReplyPart(laterCall)
    ])
  })

  it("changes only the addressed reply and leaves the previous conversation intact", () => {
    const conversation = updateAssistantReplyPart(STREAMING_CONVERSATION, {
      assistantMessageId: STREAMING_REPLY.id,
      part: RUNNING_CALL
    })

    expect(conversation.messages[0]).toBe(STREAMING_CONVERSATION.messages[0])
    expect(conversation.sources).toBe(STREAMING_CONVERSATION.sources)
    expect(STREAMING_CONVERSATION.messages.at(-1)).toBe(STREAMING_REPLY)
  })

  it.each([
    ["an absent reply", createFixtureUuidV7(99)],
    ["a user message", createFixtureUuidV7(4)],
    ["a terminal reply", createFixtureUuidV7(3)]
  ])("refuses a part for %s", (_label, assistantMessageId) => {
    expect(() =>
      updateAssistantReplyPart(STREAMING_CONVERSATION, {
        assistantMessageId,
        part: RUNNING_CALL
      })
    ).toThrow(assistantMessageId)
  })
})

describe("updateAssistantReplyPartContent", () => {
  it("appends fragments to the part in order and stamps the part's update time", () => {
    const once = updateAssistantReplyPartContent(STREAMING_CONVERSATION, {
      assistantMessageId: STREAMING_REPLY.id,
      partId: STREAMED_TEXT.id,
      content: " one",
      updatedAt: LATER
    })
    const twice = updateAssistantReplyPartContent(once, {
      assistantMessageId: STREAMING_REPLY.id,
      partId: STREAMED_TEXT.id,
      content: " two",
      updatedAt: LATER
    })

    expect(twice.messages.at(-1)).toEqual({
      ...STREAMING_REPLY,
      parts: [{ ...STREAMED_TEXT, content: "Part one two", updatedAt: LATER }]
    })
  })

  it("lists the numbers the answer cites as fragments arrive, and none once the round calls a tool", () => {
    const cited = updateAssistantReplyPartContent(STREAMING_CONVERSATION, {
      assistantMessageId: STREAMING_REPLY.id,
      partId: STREAMED_TEXT.id,
      content: " [2] and `[3]`, then [1]",
      updatedAt: LATER
    })
    const searching = updateAssistantReplyPart(cited, {
      assistantMessageId: STREAMING_REPLY.id,
      part: RUNNING_CALL
    })

    const citedReply = cited.messages.at(-1)
    const searchingReply = searching.messages.at(-1)
    expect(
      citedReply?.role === "assistant" && citedReply.answerCitationNumbers
    ).toEqual([2, 1])
    expect(
      searchingReply?.role === "assistant" &&
        searchingReply.answerCitationNumbers
    ).toEqual([])
  })

  it.each([
    ["an absent part", createFixtureUuidV7(98)],
    ["a tool call", RUNNING_CALL.id]
  ])("refuses a fragment for %s", (_label, partId) => {
    const withCall = updateAssistantReplyPart(STREAMING_CONVERSATION, {
      assistantMessageId: STREAMING_REPLY.id,
      part: RUNNING_CALL
    })

    expect(() =>
      updateAssistantReplyPartContent(withCall, {
        assistantMessageId: STREAMING_REPLY.id,
        partId,
        content: "x",
        updatedAt: LATER
      })
    ).toThrow(partId)
  })

  it("refuses a fragment for a terminal reply", () => {
    expect(() =>
      updateAssistantReplyPartContent(STREAMING_CONVERSATION, {
        assistantMessageId: createFixtureUuidV7(3),
        partId: STREAMED_TEXT.id,
        content: "x",
        updatedAt: LATER
      })
    ).toThrow("terminal")
  })
})

describe("updateConversationSources", () => {
  /** Sources a later call showed, out of number order. */
  const THIRD = Object.freeze({
    number: 3,
    url: "https://c.example/",
    title: "C"
  })
  const SECOND = Object.freeze({
    number: 2,
    url: "https://b.example/",
    title: "B"
  })

  it("adds a call's own sources to those held, in number order, and keeps the transcript by identity", () => {
    const withStored = buildChatViewConversation(EARLIER_TURN, [STORED_SOURCE])

    const conversation = updateConversationSources(withStored, [THIRD, SECOND])

    expect(conversation.sources).toEqual([STORED_SOURCE, SECOND, THIRD])
    expect(conversation.messages).toBe(withStored.messages)
    expect(withStored.sources).toEqual([STORED_SOURCE])
    expect(Object.isFrozen(conversation.sources)).toBe(true)
  })

  it("keeps one source for a number it already holds", () => {
    const withStored = buildChatViewConversation(EARLIER_TURN, [STORED_SOURCE])

    const conversation = updateConversationSources(withStored, [
      THIRD,
      STORED_SOURCE
    ])

    expect(conversation.sources).toEqual([STORED_SOURCE, THIRD])
  })

  it("keeps the source objects it holds, even when a source arrives again under the same number", () => {
    const withStored = buildChatViewConversation(EARLIER_TURN, [STORED_SOURCE])

    const conversation = updateConversationSources(withStored, [
      { ...STORED_SOURCE, title: "Moths again" },
      SECOND
    ])

    expect(conversation.sources[0]).toBe(withStored.sources[0])
    expect(conversation.sources[0]?.title).toBe("Moths")
    expect(conversation.sources[1]).toEqual(SECOND)
    expect(Object.isFrozen(conversation.sources[1])).toBe(true)
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
    "ends the reply as %s without a finish reason, keeping its parts",
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

  it.each(["completed", "interrupted", "failed"] as const)(
    "marks the reply's waiting and running calls interrupted at the time it ends as %s, as the backend does",
    (status) => {
      const finishedCall = buildToolCallPart(52, 0, {
        toolName: "read_page",
        argumentText: "{}",
        status: "failed",
        result: "Unreadable"
      })
      const waitingCall = buildToolCallPart(53, 1, {
        toolName: "read_page",
        argumentText: "{}",
        status: "awaiting-approval"
      })
      const reply = buildStreamingChatViewReply(5, [
        STREAMED_TEXT,
        RUNNING_CALL,
        finishedCall,
        waitingCall
      ])

      const conversation = updateAssistantReplyStatus(
        buildChatViewConversation([buildUserMessage(4, "Go"), reply]),
        status === "completed"
          ? {
              assistantMessageId: reply.id,
              status,
              finishReason: "stop",
              timestamp: LATER
            }
          : {
              assistantMessageId: reply.id,
              status,
              finishReason: null,
              timestamp: LATER
            }
      )

      const ended = conversation.messages.at(-1)
      expect(ended?.role === "assistant" && ended.parts).toEqual([
        STREAMED_TEXT,
        {
          ...buildChatViewReplyPart(RUNNING_CALL),
          status: "interrupted",
          updatedAt: LATER
        },
        buildChatViewReplyPart(finishedCall),
        {
          ...buildChatViewReplyPart(waitingCall),
          status: "interrupted",
          updatedAt: LATER
        }
      ])
    }
  )

  it("refuses a second terminal transition and later parts", () => {
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
      updateAssistantReplyPart(completed, {
        assistantMessageId: STREAMING_REPLY.id,
        part: RUNNING_CALL
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
  it("presents a stored conversation in stored order with its sources, frozen", () => {
    const stored = buildConversationWithSources(
      buildConversation(FIXTURE_CONVERSATION_ID, "Stored", [
        EARLIER_TURN[0],
        STORED_EARLIER_REPLY
      ]),
      [STORED_SOURCE]
    )

    const conversation = createStoredChatViewConversation(stored)

    expect(conversation).toEqual({ ...stored, messages: EARLIER_TURN })
    expect(Object.isFrozen(conversation)).toBe(true)
    expect(Object.isFrozen(conversation.messages)).toBe(true)
    expect(
      conversation.messages.every((message) => Object.isFrozen(message))
    ).toBe(true)
    expect(Object.isFrozen(conversation.sources)).toBe(true)
  })

  it("keeps a streaming reply that ends the transcript streaming so it can be followed", () => {
    const stored = buildConversation(FIXTURE_CONVERSATION_ID, null, [
      buildUserMessage(4, "Tell me more"),
      STORED_STREAMING_REPLY
    ])

    expect(createStoredChatViewConversation(stored).messages.at(-1)).toEqual(
      STREAMING_REPLY
    )
  })

  it("presents an earlier streaming reply as interrupted with its stored parts, its open calls interrupted", () => {
    const abandoned = buildStreamingAssistantMessage(3, [
      buildTextPart(30, 0, "Half an ans"),
      RUNNING_CALL
    ])
    const stored = buildConversation(FIXTURE_CONVERSATION_ID, null, [
      buildUserMessage(2, "Hi"),
      abandoned,
      buildUserMessage(4, "Still there?")
    ])

    expect(createStoredChatViewConversation(stored).messages[1]).toEqual({
      ...buildChatViewAssistantMessage(abandoned),
      parts: [
        abandoned.parts[0],
        { ...buildChatViewReplyPart(RUNNING_CALL), status: "interrupted" }
      ],
      status: "interrupted",
      finishReason: null
    })
  })

  it("keeps each open call's own update time when it presents an earlier streaming reply as interrupted", () => {
    const waitingCall = buildToolCallPart(31, 0, {
      toolName: "read_page",
      argumentText: '{"url":"https://moths.example/"}',
      status: "awaiting-approval"
    })
    const abandoned = {
      ...buildStreamingAssistantMessage(3, [
        { ...waitingCall, updatedAt: "2026-01-02T03:04:07.000Z" }
      ]),
      updatedAt: "2026-01-02T03:09:00.000Z"
    }
    const stored = buildConversation(FIXTURE_CONVERSATION_ID, null, [
      buildUserMessage(2, "Hi"),
      abandoned,
      buildUserMessage(4, "Still there?")
    ])

    const reply = createStoredChatViewConversation(stored).messages[1]

    expect(reply?.role === "assistant" && reply.parts).toEqual([
      {
        ...buildChatViewReplyPart(waitingCall),
        status: "interrupted",
        updatedAt: "2026-01-02T03:04:07.000Z"
      }
    ])
  })

  it.each([
    ["a completed reply without a finish reason", "completed", null],
    ["an interrupted reply with a finish reason", "interrupted", "stop"],
    ["a failed reply with a finish reason", "failed", "length"]
  ])("rejects %s", (_label, status, finishReason) => {
    const stored = parseStoredConversation([
      { ...STORED_EARLIER_REPLY, status, finishReason } satisfies Record<
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
      buildChatViewAssistantMessage(interrupted),
      buildUserMessage(4, "Again"),
      buildChatViewAssistantMessage(failed)
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
  it("replaces the local parts with the snapshot's instead of adding to them", () => {
    const snapshot = buildStreamingAssistantMessage(5, "Partial answer")

    const conversation = updateAssistantReplyWithSnapshot(
      STREAMING_CONVERSATION,
      snapshot
    )

    expect(conversation.messages.at(-1)).toEqual(
      buildChatViewAssistantMessage(snapshot)
    )
  })

  it("ends the reply when the snapshot is terminal", () => {
    const snapshot = buildCompletedAssistantMessage(5, "Whole answer")

    const conversation = updateAssistantReplyWithSnapshot(
      STREAMING_CONVERSATION,
      snapshot
    )

    expect(conversation.messages.at(-1)).toEqual(
      buildChatViewAssistantMessage(snapshot)
    )
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
      ...STORED_STREAMING_REPLY,
      status: "completed",
      finishReason: null
    })

    expect(() =>
      updateAssistantReplyWithSnapshot(STREAMING_CONVERSATION, snapshot)
    ).toThrow(STREAMING_REPLY.id)
  })
})
