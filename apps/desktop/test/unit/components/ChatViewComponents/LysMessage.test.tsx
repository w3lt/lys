import { render, screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import LysMessage from "@/components/ChatViewComponents/LysMessage"
import {
  buildCompletedAssistantMessage,
  buildEndedAssistantMessage,
  buildFragmentPart,
  buildStreamingAssistantMessage,
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
        message={buildCompletedAssistantMessage(2, "A **local** chat app.")}
        speakerName={SPEAKER_NAME}
        sources={NO_SOURCES}
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
          message={buildEndedAssistantMessage(2, "Partial answer", status)}
          speakerName={SPEAKER_NAME}
          sources={NO_SOURCES}
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
        message={buildStreamingAssistantMessage(2, "Thinking")}
        speakerName={SPEAKER_NAME}
        sources={NO_SOURCES}
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
        message={buildCompletedAssistantMessage(2, "Hi")}
        speakerName={SPEAKER_NAME}
        sources={NO_SOURCES}
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
    const SEARCH = buildToolCallPart(
      21,
      0,
      { toolName: "web_search", argumentText: '{"query":"moths"}' },
      { status: "succeeded", result: "Results", sourceNumbers: [1, 2] }
    )

    it("shows its reasoning and its steps collapsed, its last round's text as the cited answer, and its sources", async () => {
      const reply = {
        ...buildCompletedAssistantMessage(2, [
          buildFragmentPart("reasoning", 20, 0, "Search first."),
          buildFragmentPart("text", 22, 0, "Let me search."),
          SEARCH,
          buildFragmentPart("text", 23, 1, "Moths fly at night [1].")
        ]),
        updatedAt: "2026-01-02T03:04:14.678Z"
      }

      render(
        <LysMessage
          kind="terminal"
          message={reply}
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
        await screen.findByRole("link", { name: "Source 1: Moths" })
      ).toBeVisible()
      const sources = screen.getByRole("region", { name: "Sources" })
      expect(within(sources).getByText("Sources · 1 cited")).toBeVisible()
      expect(within(sources).getByText("1 more")).toBeVisible()
    })

    it("shows its steps without an answer while its last round's calls run, and says it is still working", () => {
      render(
        <LysMessage
          kind="streaming"
          message={buildStreamingAssistantMessage(2, [
            buildToolCallPart(
              21,
              0,
              { toolName: "web_search", argumentText: '{"query":"moths"}' },
              { status: "running" }
            )
          ])}
          sources={SOURCES}
          speakerName={SPEAKER_NAME}
        />
      )

      expect(screen.getByText("1 step · 1 tool call")).toBeInTheDocument()
      expect(
        screen.getByRole("status", { name: "Caliginia is generating" })
      ).toBeInTheDocument()
      expect(screen.queryByRole("region", { name: "Sources" })).toBeNull()
    })

    it("says it is thinking while it streams its reasoning", () => {
      render(
        <LysMessage
          kind="streaming"
          message={buildStreamingAssistantMessage(2, [
            buildFragmentPart("reasoning", 20, 0, "Hmm")
          ])}
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
          message={buildCompletedAssistantMessage(2, "Just text.")}
          sources={SOURCES}
          speakerName={SPEAKER_NAME}
        />
      )

      expect(screen.getByRole("article")).toHaveTextContent("Just text.")
      expect(screen.queryByText(/^Thought for|^Thinking$|tool call/)).toBeNull()
      expect(screen.queryByRole("region", { name: "Sources" })).toBeNull()
    })
  })
})
