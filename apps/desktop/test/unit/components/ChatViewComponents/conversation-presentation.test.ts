import { describe, expect, it } from "vitest"
import { createConversationPresentation } from "@/components/ChatViewComponents/conversation-presentation"
import {
  buildCompletedAssistantMessage,
  buildEndedAssistantMessage,
  buildStreamingAssistantMessage,
  buildUserMessage
} from "../../support/conversationFixtures"

/** First user message of the fixture transcript. */
const QUESTION = buildUserMessage(1, "What is Lys?")

/** Completed reply to {@link QUESTION}. */
const ANSWER = buildCompletedAssistantMessage(2, "A local chat app.")

/** Follow-up user message. */
const FOLLOW_UP = buildUserMessage(3, "And offline?")

describe("createConversationPresentation", () => {
  it("presents an empty transcript as completed-only with no messages", () => {
    expect(createConversationPresentation([])).toEqual({
      kind: "completed-only",
      completedMessages: []
    })
  })

  it("keeps a transcript of final messages completed-only, in order and by identity", () => {
    const interrupted = buildEndedAssistantMessage(4, "Partly", "interrupted")

    const presentation = createConversationPresentation([
      QUESTION,
      ANSWER,
      FOLLOW_UP,
      interrupted
    ])

    expect(presentation.kind).toBe("completed-only")
    expect(presentation.completedMessages).toHaveLength(4)
    presentation.completedMessages.forEach((message, index) => {
      expect(message).toBe([QUESTION, ANSWER, FOLLOW_UP, interrupted][index])
    })
  })

  it("splits a streaming final reply into the streaming tail", () => {
    const streaming = buildStreamingAssistantMessage(4, "Yes, it")

    const presentation = createConversationPresentation([
      QUESTION,
      ANSWER,
      FOLLOW_UP,
      streaming
    ])

    expect(presentation).toEqual({
      kind: "streaming-tail",
      completedMessages: [QUESTION, ANSWER, FOLLOW_UP],
      streamingMessage: streaming
    })
    expect(
      presentation.kind === "streaming-tail" && presentation.streamingMessage
    ).toBe(streaming)
  })

  it("rejects a streaming reply that is not the final message", () => {
    const streaming = buildStreamingAssistantMessage(2, "")

    expect(() =>
      createConversationPresentation([QUESTION, streaming, FOLLOW_UP])
    ).toThrow("A streaming assistant must be the transcript tail")
  })

  it("returns presentations that cannot be changed", () => {
    const presentation = createConversationPresentation([QUESTION, ANSWER])

    expect(Object.isFrozen(presentation)).toBe(true)
    expect(Object.isFrozen(presentation.completedMessages)).toBe(true)
  })
})
