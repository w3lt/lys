import { describe, expect, it } from "vitest"
import { buildAgentContext } from "../../../../src/modules/agent/agentContext"
import {
  createAssistantMessage,
  createUserMessage
} from "../../support/conversationFixtures"

describe("buildAgentContext", () => {
  it("sends the system prompt first and the new message last", () => {
    expect(buildAgentContext("You are Lys.", [], "Hello")).toEqual([
      { role: "system", content: "You are Lys." },
      { role: "user", content: "Hello" }
    ])
  })

  it("keeps earlier user messages and usable replies in transcript order", () => {
    const history = [
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
    ]

    expect(
      buildAgentContext("You are Lys.", history, "Current question")
    ).toEqual([
      { role: "system", content: "You are Lys." },
      { role: "user", content: "First question" },
      { role: "assistant", content: "Completed answer", toolCalls: [] },
      { role: "user", content: "Second question" },
      { role: "assistant", content: "Truncated answer", toolCalls: [] },
      { role: "user", content: "Third question" },
      { role: "assistant", content: "Partial answer", toolCalls: [] },
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
    expect(
      buildAgentContext(
        "You are Lys.",
        [createUserMessage(1, "Question"), reply],
        "Retry"
      )
    ).toEqual([
      { role: "system", content: "You are Lys." },
      { role: "user", content: "Question" },
      { role: "user", content: "Retry" }
    ])
  })

  it("sends only the role and text of each stored message, and no tool calls for a reply", () => {
    const history = [
      createAssistantMessage(2, "Answer", {
        status: "completed",
        finishReason: "stop"
      })
    ]

    expect(buildAgentContext("You are Lys.", history, "Next")).toStrictEqual([
      { role: "system", content: "You are Lys." },
      { role: "assistant", content: "Answer", toolCalls: [] },
      { role: "user", content: "Next" }
    ])
  })
})
