import { render, screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import LysMessage from "@/components/ChatViewComponents/LysMessage"
import {
  buildCompletedAssistantMessage,
  buildEndedAssistantMessage,
  buildStreamingAssistantMessage
} from "../../support/conversationFixtures"

describe("LysMessage", () => {
  it("renders a completed reply as Markdown under the lys label, with no status", async () => {
    render(
      <LysMessage
        kind="terminal"
        message={buildCompletedAssistantMessage(2, "A **local** chat app.")}
      />
    )

    const message = screen.getByRole("article")
    expect(message).toHaveTextContent(/^lys/)
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
        />
      )

      const announcement = screen.getByRole("status")
      expect(announcement).toHaveTextContent(label)
      expect(announcement).toHaveAttribute("aria-live", "polite")
      expect(screen.getByRole("article")).toHaveTextContent("Partial answer")
    }
  )

  it("shows the generating caret while the reply streams, and no outcome", () => {
    render(
      <LysMessage
        kind="streaming"
        message={buildStreamingAssistantMessage(2, "Thinking")}
      />
    )

    expect(
      screen.getByRole("status", { name: "Lys is generating" })
    ).toBeInTheDocument()
    expect(screen.queryByText("Stopped")).not.toBeInTheDocument()
    expect(screen.queryByText("Failed")).not.toBeInTheDocument()
  })

  it("keeps the decorative portraits out of the accessibility tree", () => {
    render(
      <LysMessage
        kind="terminal"
        message={buildCompletedAssistantMessage(2, "Hi")}
      />
    )

    expect(screen.queryByRole("img")).not.toBeInTheDocument()
  })
})
