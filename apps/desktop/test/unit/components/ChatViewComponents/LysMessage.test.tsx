import { render, screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import LysMessage from "@/components/ChatViewComponents/LysMessage"
import {
  buildCompletedChatViewReply,
  buildEndedChatViewReply,
  buildReasoningPart,
  buildTextPart,
  buildStreamingChatViewReply,
  buildToolCallPart
} from "../../support/conversationFixtures"
import { startDecodedImageHost } from "../../support/imageHostFake"

/** Name of the agent that answers, which the parent shows on every reply. */
const SPEAKER_NAME = "Caliginia"

/** Sources of a conversation that has none. */
const NO_SOURCES = Object.freeze([])

describe("LysMessage", () => {
  it("renders a completed reply as Markdown under the answering agent's name, with no status", async () => {
    render(
      <LysMessage
        kind="terminal"
        message={buildCompletedChatViewReply(2, "A **local** chat app.")}
        replyNumber={1}
        sources={NO_SOURCES}
        speakerName={SPEAKER_NAME}
      />
    )

    const message = screen.getByRole("article")
    expect(message).toHaveTextContent(/^Caliginia/)
    expect(await within(message).findByText("local")).toBeInstanceOf(
      HTMLElement
    )
    expect(within(message).getByText("local").tagName).toBe("STRONG")
    expect(within(message).queryByRole("status")).not.toBeInTheDocument()
  })

  it.each([
    ["interrupted", "Stopped"],
    ["failed", "Failed"]
  ] as const)(
    "announces an %s reply as %s, keeping its text",
    (status, label) => {
      render(
        <LysMessage
          kind="terminal"
          message={buildEndedChatViewReply(2, "Partial answer", status)}
          replyNumber={1}
          sources={NO_SOURCES}
          speakerName={SPEAKER_NAME}
        />
      )

      const announcement = screen.getByRole("status")
      expect(announcement).toHaveTextContent(label)
      expect(announcement).toHaveAttribute("aria-live", "polite")
      expect(screen.getByRole("article")).toHaveTextContent("Partial answer")
    }
  )

  it("shows the generating caret, naming the answering agent, while the reply streams, and no outcome", () => {
    render(
      <LysMessage
        kind="streaming"
        message={buildStreamingChatViewReply(2, "Thinking")}
        replyNumber={1}
        sources={NO_SOURCES}
        speakerName={SPEAKER_NAME}
      />
    )

    expect(
      screen.getByRole("status", { name: "Caliginia is generating" })
    ).toBeInTheDocument()
    expect(screen.queryByText("Stopped")).not.toBeInTheDocument()
    expect(screen.queryByText("Failed")).not.toBeInTheDocument()
  })

  it("keeps the decorative portraits out of the accessibility tree", () => {
    startDecodedImageHost()
    const { container } = render(
      <LysMessage
        kind="terminal"
        message={buildCompletedChatViewReply(2, "Hi")}
        replyNumber={1}
        sources={NO_SOURCES}
        speakerName={SPEAKER_NAME}
      />
    )

    // Both theme portraits are rendered, so their absence below is meaningful.
    expect(container.querySelectorAll("img")).toHaveLength(2)
    expect(screen.queryByRole("img")).not.toBeInTheDocument()
  })

  describe("a reply that worked with tools", () => {
    /** Sources of the conversation the reply belongs to. */
    const SOURCES = Object.freeze([
      { number: 1, url: "https://moths.example/", title: "Moths" },
      { number: 2, url: "https://lamps.example/", title: "Lamps" }
    ])

    /** Search of round 0 that found both sources. */
    const SEARCH = buildToolCallPart(21, 0, {
      toolName: "web_search",
      argumentText: '{"query":"moths"}',
      status: "succeeded",
      result: "Results",
      sourceNumbers: [1, 2]
    })

    it("shows its reasoning and its steps collapsed, its last round's text as the cited answer, and its sources", async () => {
      const reply = {
        ...buildCompletedChatViewReply(2, [
          buildReasoningPart(20, 0, "Search first."),
          buildTextPart(22, 0, "Let me search."),
          SEARCH,
          {
            ...buildTextPart(23, 1, "Moths fly at night [1]."),
            updatedAt: "2026-01-02T03:04:14.678Z"
          }
        ]),
        updatedAt: "2026-01-02T03:05:05.678Z"
      }

      render(
        <LysMessage
          kind="terminal"
          message={reply}
          replyNumber={1}
          sources={SOURCES}
          speakerName={SPEAKER_NAME}
        />
      )

      expect(screen.getByText("Thought for 1s")).toBeInTheDocument()
      expect(screen.getByText("Search first.")).not.toBeVisible()
      expect(
        screen.getByText("Worked for 9s · 1 step · 1 tool call")
      ).toBeInTheDocument()
      expect(screen.getByText("Let me search.")).not.toBeVisible()
      expect(
        await screen.findByRole("link", { name: "1, source: Moths" })
      ).toBeVisible()
      const cited = screen.getByRole("list", { name: "Sources · 1 cited" })
      expect(within(cited).getByRole("link", { name: /Moths/ })).toBeVisible()
      expect(screen.getByText("1 more")).toBeVisible()
    })

    it("links and lists only the sources it may cite, keeping other markers as text", async () => {
      render(
        <LysMessage
          kind="terminal"
          message={buildCompletedChatViewReply(2, "Moths [1] like lamps [2].")}
          replyNumber={1}
          sources={SOURCES.slice(0, 1)}
          speakerName={SPEAKER_NAME}
        />
      )

      expect(
        await screen.findByRole("link", { name: "1, source: Moths" })
      ).toBeVisible()
      expect(screen.getByText(/like lamps \[2\]\./)).toBeVisible()
      expect(screen.queryByRole("link", { name: /Lamps/ })).toBeNull()
      expect(
        screen.getByRole("list", { name: "Sources · 1 cited" })
      ).toBeVisible()
    })

    it.each([
      ["inline code", "Run `python x.py` and read `sys.argv[1]`.", []],
      ["a code block", "```\nitems[1]\n```", []],
      ["a link's text", "See [the page [1]](https://a.example/).", []],
      ["a reference link", "See [1].\n\n[1]: https://model.example/", []],
      ["math", "Take $x[1]$.", []],
      ["a leading zero", "See [01].", []],
      ["an escaped marker", String.raw`Escaped \[1\] marker.`, [1]]
    ] as const)(
      "lists as cited exactly the sources its answer links, with %s",
      async (_label, answer, linkedNumbers) => {
        render(
          <LysMessage
            kind="terminal"
            message={buildCompletedChatViewReply(2, [
              SEARCH,
              buildTextPart(23, 1, `${answer}\n\nLamps glow [2].`)
            ])}
            replyNumber={1}
            sources={SOURCES}
            speakerName={SPEAKER_NAME}
          />
        )

        await screen.findByRole("link", { name: "2, source: Lamps" })

        const linkedUrls = [...linkedNumbers, 2].map(
          (number) => SOURCES[number - 1]?.url
        )
        expect(
          screen
            .getAllByRole("link", { name: /, source: / })
            .map((link) => link.getAttribute("href"))
        ).toEqual(linkedUrls)
        const cited = screen.getByRole("list", {
          name: `Sources · ${String(linkedUrls.length)} cited`
        })
        expect(
          within(cited)
            .getAllByRole("link")
            .map((link) => link.getAttribute("href"))
        ).toEqual(linkedUrls)
      }
    )

    it("shows its steps without an answer while its last round's calls run, and says it is still working", () => {
      render(
        <LysMessage
          kind="streaming"
          message={buildStreamingChatViewReply(2, [
            buildToolCallPart(21, 0, {
              toolName: "web_search",
              argumentText: '{"query":"moths"}',
              status: "running"
            })
          ])}
          replyNumber={1}
          sources={SOURCES}
          speakerName={SPEAKER_NAME}
        />
      )

      expect(screen.getByText("1 step · 1 tool call")).toBeInTheDocument()
      expect(
        screen.getByRole("status", { name: "Caliginia is generating" })
      ).toBeInTheDocument()
      expect(screen.queryByText(/^Sources/)).toBeNull()
    })

    it("says it is thinking while it streams its reasoning", () => {
      render(
        <LysMessage
          kind="streaming"
          message={buildStreamingChatViewReply(2, [
            buildReasoningPart(20, 0, "Hmm")
          ])}
          replyNumber={1}
          sources={SOURCES}
          speakerName={SPEAKER_NAME}
        />
      )

      expect(screen.getByText("Thinking")).toBeInTheDocument()
    })

    it("shows neither reasoning, steps, nor sources for a reply that has none", () => {
      render(
        <LysMessage
          kind="terminal"
          message={buildCompletedChatViewReply(2, "Just text.")}
          replyNumber={1}
          sources={SOURCES}
          speakerName={SPEAKER_NAME}
        />
      )

      expect(screen.getByRole("article")).toHaveTextContent("Just text.")
      expect(screen.queryByText(/^Thought for|^Thinking$|tool call/)).toBeNull()
      expect(screen.queryByText(/^Sources/)).toBeNull()
    })
  })
})
