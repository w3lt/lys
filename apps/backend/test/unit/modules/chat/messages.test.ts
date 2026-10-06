import { describe, expect, it } from "vitest"
import { buildChatMessages } from "../../../../src/modules/chat/messages"
import {
  createAssistantMessage,
  createConversationTurn,
  createUserMessage
} from "../../support/conversationFixtures"

describe("buildChatMessages", () => {
  it("sends the saved system prompt first and the current user message last", () => {
    const turn = createConversationTurn({
      systemPrompt: "You are Lys.",
      earlierMessages: [],
      userMessageContent: "Hello"
    })

    expect(buildChatMessages(turn)).toEqual([
      { role: "system", content: "You are Lys." },
      { role: "user", content: "Hello" }
    ])
  })

  it("keeps earlier user messages and usable replies in transcript order", () => {
    const turn = createConversationTurn({
      systemPrompt: "You are Lys.",
      earlierMessages: [
        createUserMessage(1, "First question"),
        createAssistantMessage(2, "Completed answer", {
          status: "completed",
          finishReason: "stop"
        }),
        createUserMessage(3, "Second question"),
        createAssistantMessage(4, "Truncated answer", {
          status: "completed",
          finishReason: "length"
        }),
        createUserMessage(5, "Third question"),
        createAssistantMessage(6, "Partial answer", { status: "interrupted" })
      ],
      userMessageContent: "Current question"
    })

    expect(buildChatMessages(turn)).toEqual([
      { role: "system", content: "You are Lys." },
      { role: "user", content: "First question" },
      { role: "assistant", content: "Completed answer" },
      { role: "user", content: "Second question" },
      { role: "assistant", content: "Truncated answer" },
      { role: "user", content: "Third question" },
      { role: "assistant", content: "Partial answer" },
      { role: "user", content: "Current question" }
    ])
  })

  it.each([
    [
      "a failed reply",
      createAssistantMessage(2, "Failed text", { status: "failed" })
    ],
    [
      "a reply still streaming",
      createAssistantMessage(2, "Streaming text", { status: "streaming" })
    ],
    [
      "an empty interrupted reply",
      createAssistantMessage(2, "", { status: "interrupted" })
    ],
    [
      "an empty completed reply",
      createAssistantMessage(2, "", {
        status: "completed",
        finishReason: "stop"
      })
    ]
  ])("excludes %s from the context", (_label, reply) => {
    const turn = createConversationTurn({
      systemPrompt: "You are Lys.",
      earlierMessages: [createUserMessage(1, "Question"), reply],
      userMessageContent: "Retry"
    })

    expect(buildChatMessages(turn)).toEqual([
      { role: "system", content: "You are Lys." },
      { role: "user", content: "Question" },
      { role: "user", content: "Retry" }
    ])
  })

  it("sends only the role and content of each stored message", () => {
    const turn = createConversationTurn({
      systemPrompt: "You are Lys.",
      earlierMessages: [
        createAssistantMessage(2, "Answer", {
          status: "completed",
          finishReason: "stop"
        })
      ],
      userMessageContent: "Next"
    })

    for (const message of buildChatMessages(turn)) {
      expect(Object.keys(message).toSorted()).toEqual(["content", "role"])
    }
  })
})
