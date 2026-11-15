import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CALIGINIA_AGENT_CODE, type ToolCallReplyPart } from "@lys/share"
import { describe, expect, it, vi } from "vitest"
import ConversationTranscript, {
  type ConversationTranscriptProps
} from "@/components/ChatViewComponents/ConversationTranscript"
import type { CompletedConversationMessage } from "@/lib/store/chat-view/conversation-transitions"
import {
  buildCompletedChatViewReply,
  buildDelegatorMessage,
  buildJob,
  buildJobCard,
  buildJobReport,
  buildReasoningPart,
  buildStreamingChatViewReply,
  buildTextPart,
  buildToolCallPart,
  buildUserMessage,
  buildUserMessageWithReports,
  buildWakeUpMessage,
  createFixtureUuidV7
} from "../../support/conversationFixtures"

/** First user message of the fixture transcript. */
const QUESTION = buildUserMessage(1, "What is Lys?")

/** Completed reply to {@link QUESTION}. */
const ANSWER = buildCompletedChatViewReply(2, "A local chat app.")

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
 * Job properties of a main conversation that started no job: no cards, no
 * delegator, and callbacks nothing calls.
 */
const NO_JOBS = Object.freeze({
  jobCards: [],
  delegatorName: undefined,
  onOpenJob: vi.fn(),
  onStopJob: vi.fn()
})

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
const EARLIER_CITING_REPLY = buildCompletedChatViewReply(2, [
  buildSearchPart(20, 1),
  buildTextPart(21, 1, "Moths [1] like lamps [2].")
])

/** Parts of the later reply, whose search shows source 2. */
const LATER_CITING_REPLY_PARTS = Object.freeze([
  buildSearchPart(40, 2),
  buildTextPart(41, 1, "Lamps [2].")
])

/**
 * Parts of a reply that reasoned, searched, and answered citing source 1, so
 * it shows every disclosure a reply has.
 */
const TOOL_REPLY_PARTS = Object.freeze([
  buildReasoningPart(20, 0, "Search first."),
  buildTextPart(21, 0, "Let me search."),
  buildToolCallPart(22, 0, {
    toolName: "web_search",
    argumentText: '{"query":"moths"}',
    status: "succeeded",
    result: "Results",
    sourceNumbers: [1, 2]
  }),
  buildTextPart(23, 1, "Moths [1].")
])

/** Sources the search of {@link TOOL_REPLY_PARTS} showed. */
const TOOL_REPLY_SOURCES = Object.freeze([
  { number: 1, url: "https://moths.example/", title: "Moths" },
  { number: 2, url: "https://lamps.example/", title: "Lamps" }
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
        {...NO_JOBS}
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
        {...NO_JOBS}
        completedMessages={[QUESTION, ANSWER, FOLLOW_UP]}
        kind="streaming-tail"
        speakerName={SPEAKER_NAME}
        sources={NO_SOURCES}
        streamingMessage={buildStreamingChatViewReply(4, "Yes, it")}
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
        {...NO_JOBS}
        completedMessages={[QUESTION, ANSWER, FOLLOW_UP]}
        kind="streaming-tail"
        sources={NO_SOURCES}
        speakerName={CALIGINIA_AGENT_CODE}
        streamingMessage={buildStreamingChatViewReply(4, "Yes, it")}
      />
    )
    expect(listRenderedMessages()[1]).toBe("caliginiaA local chat app.")

    rerender(
      <ConversationTranscript
        {...NO_JOBS}
        completedMessages={[QUESTION, ANSWER, FOLLOW_UP]}
        kind="streaming-tail"
        speakerName={SPEAKER_NAME}
        sources={NO_SOURCES}
        streamingMessage={buildStreamingChatViewReply(4, "Yes, it")}
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
          buildCompletedChatViewReply(4, LATER_CITING_REPLY_PARTS)
        ]
      }
    ],
    [
      "a conversation whose later reply streams",
      {
        kind: "streaming-tail",
        completedMessages: [QUESTION, EARLIER_CITING_REPLY, FOLLOW_UP],
        streamingMessage: buildStreamingChatViewReply(
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
          {...NO_JOBS}
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
        {...NO_JOBS}
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
        {...NO_JOBS}
        completedMessages={[QUESTION]}
        kind="streaming-tail"
        speakerName={SPEAKER_NAME}
        sources={NO_SOURCES}
        streamingMessage={buildStreamingChatViewReply(2, "A local")}
      />
    )
    const [question] = screen.getAllByRole("article")

    rerender(
      <ConversationTranscript
        {...NO_JOBS}
        completedMessages={[QUESTION, ANSWER, FOLLOW_UP]}
        kind="completed-only"
        speakerName={SPEAKER_NAME}
        sources={NO_SOURCES}
      />
    )

    expect(screen.getAllByRole("article")[0]).toBe(question)
  })

  it("keeps the reply's open disclosures open and its focused link focused, on the same elements, when the reply ends", async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      <ConversationTranscript
        {...NO_JOBS}
        completedMessages={[QUESTION]}
        kind="streaming-tail"
        speakerName={SPEAKER_NAME}
        sources={TOOL_REPLY_SOURCES}
        streamingMessage={buildStreamingChatViewReply(2, TOOL_REPLY_PARTS)}
      />
    )
    const link = await screen.findByRole("link", { name: "1, source: Moths" })
    for (const name of [
      /^(Thinking|Thought for \d+s), reply 1$/,
      "1 step · 1 tool call, reply 1",
      "web_search moths Done, reply 1",
      "1 more, reply 1"
    ])
      await user.click(screen.getByLabelText(name))
    link.focus()
    const disclosures = screen.getAllByRole("group")

    rerender(
      <ConversationTranscript
        {...NO_JOBS}
        completedMessages={[
          QUESTION,
          buildCompletedChatViewReply(2, TOOL_REPLY_PARTS)
        ]}
        kind="completed-only"
        speakerName={SPEAKER_NAME}
        sources={TOOL_REPLY_SOURCES}
      />
    )

    const ended = screen.getAllByRole("group")
    expect(ended).toHaveLength(4)
    expect(
      ended.map((disclosure, index) => disclosure === disclosures[index])
    ).toEqual([true, true, true, true])
    for (const disclosure of ended) expect(disclosure).toHaveAttribute("open")
    expect(screen.getByLabelText(/^Worked for /)).toBeInTheDocument()
    expect(link).toBeInTheDocument()
    expect(link).toHaveFocus()
  })

  it("renders a new message element when another message takes a position", () => {
    const { rerender } = render(
      <ConversationTranscript
        {...NO_JOBS}
        completedMessages={[QUESTION, ANSWER]}
        kind="completed-only"
        speakerName={SPEAKER_NAME}
        sources={NO_SOURCES}
      />
    )
    const [question] = screen.getAllByRole("article")

    rerender(
      <ConversationTranscript
        {...NO_JOBS}
        completedMessages={[
          buildUserMessage(11, "Another conversation"),
          buildCompletedChatViewReply(12, "Another reply")
        ]}
        kind="completed-only"
        speakerName={SPEAKER_NAME}
        sources={NO_SOURCES}
      />
    )

    expect(screen.getAllByRole("article")[0]).not.toBe(question)
    expect(question).not.toBeInTheDocument()
  })

  it("shows a job's new state on its reply's card when the job changes", () => {
    const messages = [
      QUESTION,
      buildCompletedChatViewReply(2, [
        buildToolCallPart(65, 0, {
          toolName: "delegate_work",
          argumentText:
            '{"agent":"nyx","title":"News","instructions":"Find the news."}',
          status: "succeeded",
          result: "Job 1 started.",
          sourceNumbers: []
        }),
        buildTextPart(23, 1, "Nyx is on it.")
      ])
    ]
    const { rerender } = render(
      <ConversationTranscript
        {...NO_JOBS}
        completedMessages={messages}
        jobCards={[buildJobCard(buildJob())]}
        kind="completed-only"
        speakerName={SPEAKER_NAME}
        sources={NO_SOURCES}
      />
    )
    expect(screen.getByText("Working")).toBeInTheDocument()

    rerender(
      <ConversationTranscript
        {...NO_JOBS}
        completedMessages={messages}
        jobCards={[buildJobCard(buildJob({ state: "replied" }))]}
        kind="completed-only"
        speakerName={SPEAKER_NAME}
        sources={NO_SOURCES}
      />
    )

    expect(screen.getByText("Replied")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Stop job 1" })).toBeNull()
  })

  it("names the agent of a delivered report from its job's card", async () => {
    const user = userEvent.setup()
    render(
      <ConversationTranscript
        {...NO_JOBS}
        completedMessages={[
          QUESTION,
          ANSWER,
          buildWakeUpMessage(5, [buildJobReport()])
        ]}
        jobCards={[buildJobCard(buildJob())]}
        kind="completed-only"
        speakerName={SPEAKER_NAME}
        sources={NO_SOURCES}
      />
    )

    await user.click(screen.getByText("Reports · 1"))

    expect(screen.getByText("Nyx · News · Result")).toBeVisible()
  })

  it.for<[string, CompletedConversationMessage[], string, string[]]>([
    [
      "messages of the person",
      [
        buildUserMessageWithReports(QUESTION, [buildJobReport()]),
        ANSWER,
        buildUserMessageWithReports(FOLLOW_UP, [
          buildJobReport({ id: createFixtureUuidV7(69) })
        ])
      ],
      "1 report delivered with this message",
      [
        "1 report delivered with this message, message 1",
        "1 report delivered with this message, message 2"
      ]
    ],
    [
      "wake-up messages",
      [
        QUESTION,
        ANSWER,
        buildWakeUpMessage(5, [buildJobReport()]),
        buildCompletedChatViewReply(6, "Nyx found the news."),
        buildWakeUpMessage(7, [buildJobReport({ id: createFixtureUuidV7(69) })])
      ],
      "Reports · 1",
      ["Reports · 1, message 2", "Reports · 1, message 3"]
    ]
  ])(
    "names apart by message the report lines of two %s that each delivered one report, which show the same label",
    ([, messages, shownLabel, names]) => {
      render(
        <ConversationTranscript
          {...NO_JOBS}
          completedMessages={messages}
          kind="completed-only"
          speakerName={SPEAKER_NAME}
          sources={NO_SOURCES}
        />
      )

      expect(
        names.map((name) => screen.getByLabelText(name).textContent)
      ).toEqual([shownLabel, shownLabel])
    }
  )

  it("shows a job's messages under the delegator's name when that name changes", () => {
    const messages = [
      buildDelegatorMessage(68, "Find the news."),
      buildCompletedChatViewReply(61, "Here is the news.")
    ]
    const { rerender } = render(
      <ConversationTranscript
        {...NO_JOBS}
        completedMessages={messages}
        delegatorName={CALIGINIA_AGENT_CODE}
        kind="completed-only"
        speakerName="Nyx"
        sources={NO_SOURCES}
      />
    )
    expect(listRenderedMessages()[0]).toBe("caliginiaFind the news.")

    rerender(
      <ConversationTranscript
        {...NO_JOBS}
        completedMessages={messages}
        delegatorName={SPEAKER_NAME}
        kind="completed-only"
        speakerName="Nyx"
        sources={NO_SOURCES}
      />
    )

    expect(listRenderedMessages()).toEqual([
      "CaliginiaFind the news.",
      "NyxHere is the news."
    ])
  })
})
