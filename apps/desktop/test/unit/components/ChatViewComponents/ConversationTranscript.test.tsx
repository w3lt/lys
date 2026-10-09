import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import ConversationTranscript from "@/components/ChatViewComponents/ConversationTranscript"
import {
  buildCompletedAssistantMessage,
  buildStreamingAssistantMessage,
  buildUserMessage
} from "../../support/conversationFixtures"

/** First user message of the fixture transcript. */
const QUESTION = buildUserMessage(1, "What is Lys?")

/** Completed reply to {@link QUESTION}. */
const ANSWER = buildCompletedAssistantMessage(2, "A local chat app.")

/** Follow-up user message. */
const FOLLOW_UP = buildUserMessage(3, "Does it work offline?")

/**
 * Lists the speaker label and text of every rendered message, in order.
 *
 * @returns One `speaker: text` line per message article.
 */
function listRenderedMessages(): string[] {
  return screen
    .getAllByRole("article")
    .map((article) => article.textContent ?? "")
}

describe("ConversationTranscript", () => {
  it("renders completed messages in order with their speakers", () => {
    render(
      <ConversationTranscript
        completedMessages={[QUESTION, ANSWER, FOLLOW_UP]}
        kind="completed-only"
      />
    )

    expect(listRenderedMessages()).toEqual([
      "youWhat is Lys?",
      "lysA local chat app.",
      "youDoes it work offline?"
    ])
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })

  it("renders the streaming reply after the completed messages", () => {
    render(
      <ConversationTranscript
        completedMessages={[QUESTION, ANSWER, FOLLOW_UP]}
        kind="streaming-tail"
        streamingMessage={buildStreamingAssistantMessage(4, "Yes, it")}
      />
    )

    expect(listRenderedMessages().at(-1)).toBe("lysYes, it")
    expect(
      screen.getByRole("status", { name: "Lys is generating" })
    ).toBeInTheDocument()
  })

  it("announces a lifecycle error after the messages", () => {
    render(
      <ConversationTranscript
        completedMessages={[QUESTION]}
        error="The backend stopped before the reply finished."
        kind="completed-only"
      />
    )

    const error = screen.getByRole("status")
    expect(error).toHaveTextContent(
      "Chat issueThe backend stopped before the reply finished."
    )
    expect(error).toHaveAttribute("aria-live", "polite")
    expect(
      screen.getByRole("article").compareDocumentPosition(error) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it("keeps each rendered message when later messages arrive", () => {
    const { rerender } = render(
      <ConversationTranscript
        completedMessages={[QUESTION]}
        kind="streaming-tail"
        streamingMessage={buildStreamingAssistantMessage(2, "A local")}
      />
    )
    const [question] = screen.getAllByRole("article")

    rerender(
      <ConversationTranscript
        completedMessages={[QUESTION, ANSWER, FOLLOW_UP]}
        kind="completed-only"
      />
    )

    expect(screen.getAllByRole("article")[0]).toBe(question)
  })

  it("renders a new message element when another message takes a position", () => {
    const { rerender } = render(
      <ConversationTranscript
        completedMessages={[QUESTION, ANSWER]}
        kind="completed-only"
      />
    )
    const [question] = screen.getAllByRole("article")

    rerender(
      <ConversationTranscript
        completedMessages={[
          buildUserMessage(11, "Another conversation"),
          buildCompletedAssistantMessage(12, "Another reply")
        ]}
        kind="completed-only"
      />
    )

    expect(screen.getAllByRole("article")[0]).not.toBe(question)
    expect(question).not.toBeInTheDocument()
  })
})
