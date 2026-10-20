import { render, screen, within } from "@testing-library/react"
import { CALIGINIA_AGENT_CODE, type ToolCallReplyPart } from "@lys/share"
import { describe, expect, it } from "vitest"
import ConversationTranscript, {
  type ConversationTranscriptProps
} from "@/components/ChatViewComponents/ConversationTranscript"
import {
  buildCompletedAssistantMessage,
  buildStreamingAssistantMessage,
  buildTextPart,
  buildToolCallPart,
  buildUserMessage
} from "../../support/conversationFixtures"

/** First user message of the fixture transcript. */
const QUESTION = buildUserMessage(1, "What is Lys?")

/** Completed reply to {@link QUESTION}. */
const ANSWER = buildCompletedAssistantMessage(2, "A local chat app.")

/** Follow-up user message. */
const FOLLOW_UP = buildUserMessage(3, "Does it work offline?")

/** Name of the agent that answers, which the parent shows on every reply. */
const SPEAKER_NAME = "Caliginia"

/**
 * Lists the text of every rendered message, in order.
 *
 * @returns The text content of each message article: its speaker label
 * immediately followed by the message text, with nothing between them, such
 * as `youWhat is Lys?`.
 */
function listRenderedMessages(): string[] {
  return screen
    .getAllByRole("article")
    .map((article) => article.textContent ?? "")
}

/** Sources of a conversation that has none. */
const NO_SOURCES = Object.freeze([])

/**
 * Builds a round-0 search that showed one source.
 *
 * @param sequence - Sequence of the part.
 * @param sourceNumber - Number of the source the search showed.
 * @returns The succeeded search part.
 */
function buildSearchPart(
  sequence: number,
  sourceNumber: number
): ToolCallReplyPart {
  return buildToolCallPart(sequence, 0, {
    toolName: "web_search",
    argumentText: '{"query":"moths"}',
    status: "succeeded",
    result: "Results",
    sourceNumbers: [sourceNumber]
  })
}

/**
 * Reply whose search showed source 1 and that also cites 2, a number only a
 * later reply's search shows.
 */
const EARLIER_CITING_REPLY = buildCompletedAssistantMessage(2, [
  buildSearchPart(20, 1),
  buildTextPart(21, 1, "Moths [1] like lamps [2].")
])

/** Parts of the later reply, whose search shows source 2. */
const LATER_CITING_REPLY_PARTS = Object.freeze([
  buildSearchPart(40, 2),
  buildTextPart(41, 1, "Lamps [2].")
])

/** The messages of a transcript, in either of its kinds. */
type TranscriptMessages =
  | Pick<
      Extract<ConversationTranscriptProps, { kind: "completed-only" }>,
      "kind" | "completedMessages"
    >
  | Pick<
      Extract<ConversationTranscriptProps, { kind: "streaming-tail" }>,
      "kind" | "completedMessages" | "streamingMessage"
    >

describe("ConversationTranscript", () => {
  it("renders completed messages in order with their speakers", () => {
    render(
      <ConversationTranscript
        completedMessages={[QUESTION, ANSWER, FOLLOW_UP]}
        kind="completed-only"
        speakerName={SPEAKER_NAME}
        sources={NO_SOURCES}
      />
    )

    expect(listRenderedMessages()).toEqual([
      "youWhat is Lys?",
      "CaliginiaA local chat app.",
      "youDoes it work offline?"
    ])
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })

  it("renders the streaming reply after the completed messages", () => {
    render(
      <ConversationTranscript
        completedMessages={[QUESTION, ANSWER, FOLLOW_UP]}
        kind="streaming-tail"
        speakerName={SPEAKER_NAME}
        sources={NO_SOURCES}
        streamingMessage={buildStreamingAssistantMessage(4, "Yes, it")}
      />
    )

    expect(listRenderedMessages().at(-1)).toBe("CaliginiaYes, it")
    expect(
      screen.getByRole("status", { name: "Caliginia is generating" })
    ).toBeInTheDocument()
  })

  it("shows every reply under the answering agent's name when that name changes", () => {
    const { rerender } = render(
      <ConversationTranscript
        completedMessages={[QUESTION, ANSWER, FOLLOW_UP]}
        kind="streaming-tail"
        sources={NO_SOURCES}
        speakerName={CALIGINIA_AGENT_CODE}
        streamingMessage={buildStreamingAssistantMessage(4, "Yes, it")}
      />
    )
    expect(listRenderedMessages()[1]).toBe("caliginiaA local chat app.")

    rerender(
      <ConversationTranscript
        completedMessages={[QUESTION, ANSWER, FOLLOW_UP]}
        kind="streaming-tail"
        speakerName={SPEAKER_NAME}
        sources={NO_SOURCES}
        streamingMessage={buildStreamingAssistantMessage(4, "Yes, it")}
      />
    )

    expect(listRenderedMessages()).toEqual([
      "youWhat is Lys?",
      "CaliginiaA local chat app.",
      "youDoes it work offline?",
      "CaliginiaYes, it"
    ])
    expect(
      screen.getByRole("status", { name: "Caliginia is generating" })
    ).toBeInTheDocument()
  })

  it.each<[string, TranscriptMessages]>([
    [
      "a finished conversation",
      {
        kind: "completed-only",
        completedMessages: [
          QUESTION,
          EARLIER_CITING_REPLY,
          FOLLOW_UP,
          buildCompletedAssistantMessage(4, LATER_CITING_REPLY_PARTS)
        ]
      }
    ],
    [
      "a conversation whose later reply streams",
      {
        kind: "streaming-tail",
        completedMessages: [QUESTION, EARLIER_CITING_REPLY, FOLLOW_UP],
        streamingMessage: buildStreamingAssistantMessage(
          4,
          LATER_CITING_REPLY_PARTS
        )
      }
    ]
  ])(
    "links each reply's citations only to sources its own or an earlier reply's calls showed, in %s",
    async (_label, messages) => {
      render(
        <ConversationTranscript
          {...messages}
          speakerName={SPEAKER_NAME}
          sources={[
            { number: 1, url: "https://moths.example/", title: "Moths" },
            { number: 2, url: "https://lamps.example/", title: "Lamps" }
          ]}
        />
      )
      const [, earlier, , later] = screen
        .getAllByRole("article")
        .map((article) => within(article))

      expect(
        await later?.findByRole("link", { name: "2, source: Lamps" })
      ).toBeVisible()
      expect(
        earlier?.getByRole("link", { name: "1, source: Moths" })
      ).toBeVisible()
      expect(earlier?.getByText(/like lamps \[2\]\./)).toBeVisible()
      expect(earlier?.queryByRole("link", { name: /Lamps/ })).toBeNull()
    }
  )

  it("announces a lifecycle error after the messages", () => {
    render(
      <ConversationTranscript
        completedMessages={[QUESTION]}
        error="The backend stopped before the reply finished."
        kind="completed-only"
        speakerName={SPEAKER_NAME}
        sources={NO_SOURCES}
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
        speakerName={SPEAKER_NAME}
        sources={NO_SOURCES}
        streamingMessage={buildStreamingAssistantMessage(2, "A local")}
      />
    )
    const [question] = screen.getAllByRole("article")

    rerender(
      <ConversationTranscript
        completedMessages={[QUESTION, ANSWER, FOLLOW_UP]}
        kind="completed-only"
        speakerName={SPEAKER_NAME}
        sources={NO_SOURCES}
      />
    )

    expect(screen.getAllByRole("article")[0]).toBe(question)
  })

  it("renders a new message element when another message takes a position", () => {
    const { rerender } = render(
      <ConversationTranscript
        completedMessages={[QUESTION, ANSWER]}
        kind="completed-only"
        speakerName={SPEAKER_NAME}
        sources={NO_SOURCES}
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
        speakerName={SPEAKER_NAME}
        sources={NO_SOURCES}
      />
    )

    expect(screen.getAllByRole("article")[0]).not.toBe(question)
    expect(question).not.toBeInTheDocument()
  })
})
