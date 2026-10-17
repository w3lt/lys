import { describe, expect, it } from "vitest"
import { buildAgentContext } from "../../../../src/modules/agent/agentContext"
import {
  createAssistantMessage,
  createFixtureUuidV7,
  createReasoningPart,
  createTextPart,
  createToolCallPart,
  createUserMessage
} from "../../support/conversationFixtures"

/** A stored web search call in round 0 that succeeded. */
const SUCCEEDED_SEARCH = createToolCallPart(
  {
    sequence: 21,
    round: 0,
    toolName: "web_search",
    argumentText: '{"query":"moths"}'
  },
  {
    status: "succeeded",
    result: "Source [1]\nTitle: Moths",
    sourceNumbers: [1]
  }
)

/** A stored page read in round 0 that failed. */
const FAILED_READ = createToolCallPart(
  {
    sequence: 22,
    round: 0,
    toolName: "read_page",
    argumentText: '{"url":"https://moths.example/"}'
  },
  { status: "failed", result: "The page did not answer." }
)

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
      createAssistantMessage(2, [createTextPart(12, 0, "Completed answer")], {
        status: "completed",
        finishReason: "stop"
      }),
      createUserMessage(3, "Second question"),
      createAssistantMessage(4, [createTextPart(14, 0, "Truncated answer")], {
        status: "completed",
        finishReason: "length"
      }),
      createUserMessage(5, "Third question"),
      createAssistantMessage(6, [createTextPart(16, 0, "Partial answer")], {
        status: "interrupted"
      })
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

  it("sends each round of a reply as its text and answered calls, then each call's result", () => {
    const history = [
      createUserMessage(1, "Tell me about moths"),
      createAssistantMessage(
        2,
        [
          createTextPart(20, 0, "Let me "),
          createTextPart(23, 0, "look."),
          SUCCEEDED_SEARCH,
          FAILED_READ,
          createTextPart(24, 1, "Moths fly at night [1].")
        ],
        { status: "completed", finishReason: "stop" }
      )
    ]

    expect(buildAgentContext("You are Lys.", history, "More?")).toEqual([
      { role: "system", content: "You are Lys." },
      { role: "user", content: "Tell me about moths" },
      {
        role: "assistant",
        content: "Let me look.",
        toolCalls: [
          {
            id: SUCCEEDED_SEARCH.id,
            toolName: "web_search",
            argumentText: '{"query":"moths"}'
          },
          {
            id: FAILED_READ.id,
            toolName: "read_page",
            argumentText: '{"url":"https://moths.example/"}'
          }
        ]
      },
      {
        role: "tool",
        toolCallId: SUCCEEDED_SEARCH.id,
        content: "Source [1]\nTitle: Moths"
      },
      {
        role: "tool",
        toolCallId: FAILED_READ.id,
        content: "The page did not answer."
      },
      { role: "assistant", content: "Moths fly at night [1].", toolCalls: [] },
      { role: "user", content: "More?" }
    ])
  })

  it("sends a rejected call with the rejection the model read, and a round of calls without text", () => {
    const rejected = createToolCallPart(
      { sequence: 21, round: 0, toolName: "read_page", argumentText: "{}" },
      { status: "rejected", result: "The person did not allow this call." }
    )
    const history = [
      createAssistantMessage(2, [rejected], { status: "interrupted" })
    ]

    expect(buildAgentContext("You are Lys.", history, "Why?")).toEqual([
      { role: "system", content: "You are Lys." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: rejected.id, toolName: "read_page", argumentText: "{}" }
        ]
      },
      {
        role: "tool",
        toolCallId: rejected.id,
        content: "The person did not allow this call."
      },
      { role: "user", content: "Why?" }
    ])
  })

  it("leaves out reasoning, calls without a result, and rounds left with nothing to send", () => {
    const interrupted = createToolCallPart(
      { sequence: 25, round: 1, toolName: "web_search", argumentText: "{}" },
      { status: "interrupted" }
    )
    const history = [
      createAssistantMessage(
        2,
        [
          createReasoningPart(20, 0, "Search first."),
          createTextPart(23, 0, "Searching."),
          createReasoningPart(24, 1, "Then read."),
          interrupted
        ],
        { status: "interrupted" }
      )
    ]

    expect(buildAgentContext("You are Lys.", history, "Go on")).toEqual([
      { role: "system", content: "You are Lys." },
      { role: "assistant", content: "Searching.", toolCalls: [] },
      { role: "user", content: "Go on" }
    ])
  })

  it.each([
    [
      "a failed reply",
      createAssistantMessage(
        2,
        [createTextPart(12, 0, "Failed text"), SUCCEEDED_SEARCH],
        { status: "failed" }
      )
    ],
    [
      "a reply still streaming",
      createAssistantMessage(2, [createTextPart(12, 0, "Streaming text")], {
        status: "streaming"
      })
    ],
    [
      "an interrupted reply without parts",
      createAssistantMessage(2, [], { status: "interrupted" })
    ],
    [
      "a completed reply with only reasoning",
      createAssistantMessage(2, [createReasoningPart(12, 0, "Hmm.")], {
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

  it("sends only the fields the model reads, without stored identities, times, or source numbers", () => {
    const history = [
      createAssistantMessage(2, [createTextPart(12, 0, "Answer")], {
        status: "completed",
        finishReason: "stop"
      })
    ]

    expect(buildAgentContext("You are Lys.", history, "Next")).toStrictEqual([
      { role: "system", content: "You are Lys." },
      { role: "assistant", content: "Answer", toolCalls: [] },
      { role: "user", content: "Next" }
    ])
    expect(
      buildAgentContext(
        "You are Lys.",
        [
          createAssistantMessage(2, [SUCCEEDED_SEARCH], {
            status: "completed",
            finishReason: "stop"
          })
        ],
        "Next"
      )[1]
    ).toStrictEqual({
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: createFixtureUuidV7(21),
          toolName: "web_search",
          argumentText: '{"query":"moths"}'
        }
      ]
    })
  })
})
