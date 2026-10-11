import { render, screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import LysMessage from "@/components/ChatViewComponents/LysMessage"
import {
  buildCompletedAssistantMessage,
  buildEndedAssistantMessage,
  buildStreamingAssistantMessage
} from "../../support/conversationFixtures"
import { startDecodedImageHost } from "../../support/imageHostFake"

/** Name of the agent that answers, which the parent shows on every reply. */
const SPEAKER_NAME = "Caliginia"

describe("LysMessage", () => {
  it("renders a completed reply as Markdown under the answering agent's name, with no status", async () => {
    render(
      <LysMessage
        kind="terminal"
        message={buildCompletedAssistantMessage(2, "A **local** chat app.")}
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
          message={buildEndedAssistantMessage(2, "Partial answer", status)}
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
        message={buildStreamingAssistantMessage(2, "Thinking")}
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
        message={buildCompletedAssistantMessage(2, "Hi")}
        speakerName={SPEAKER_NAME}
      />
    )

    // Both theme portraits are rendered, so their absence below is meaningful.
    expect(container.querySelectorAll("img")).toHaveLength(2)
    expect(screen.queryByRole("img")).not.toBeInTheDocument()
  })
})
