import { createRef } from "react"
import { fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { STARTER_PROMPTS } from "@/app/content"
import ConversationPanel from "@/components/ChatViewComponents/ConversationPanel"
import {
  buildCompletedAssistantMessage,
  buildStreamingAssistantMessage,
  buildUserMessage
} from "../../support/conversationFixtures"

/** User message of a started conversation. */
const QUESTION = buildUserMessage(1, "What is Lys?")

/** Completed reply to {@link QUESTION}. */
const ANSWER = buildCompletedAssistantMessage(2, "A local chat app.")

/**
 * Builds the parent-owned controls of an idle, pinned panel.
 *
 * @returns Fresh callback spies, the transcript ref, and idle state.
 */
function buildPanelControls() {
  return {
    activity: "idle" as const,
    isAtBottom: true,
    onJumpToLatest: vi.fn(),
    onSendMessage: vi.fn(() => Promise.resolve()),
    onTranscriptScroll: vi.fn(),
    transcriptRef: createRef<HTMLDivElement>()
  }
}

describe("ConversationPanel", () => {
  it("is a region named Conversation holding the transcript", () => {
    render(
      <ConversationPanel
        {...buildPanelControls()}
        completedMessages={[QUESTION, ANSWER]}
        kind="completed-only"
      />
    )

    const region = screen.getByRole("region", { name: "Conversation" })
    expect(within(region).getAllByRole("article")).toHaveLength(2)
    expect(
      within(region).queryByRole("group", { name: "Starter prompts" })
    ).not.toBeInTheDocument()
  })

  it("offers the starter prompts while the conversation is empty", async () => {
    const controls = buildPanelControls()
    const user = userEvent.setup()
    render(
      <ConversationPanel
        {...controls}
        completedMessages={[]}
        kind="completed-only"
      />
    )

    await user.click(screen.getByRole("button", { name: STARTER_PROMPTS[2] }))

    expect(controls.onSendMessage).toHaveBeenCalledExactlyOnceWith(
      STARTER_PROMPTS[2]
    )
    expect(screen.queryByRole("article")).not.toBeInTheDocument()
  })

  it("shows an error instead of the starter prompts when an empty conversation failed", () => {
    render(
      <ConversationPanel
        {...buildPanelControls()}
        completedMessages={[]}
        error="Chat is unavailable."
        kind="completed-only"
      />
    )

    expect(
      screen.queryByRole("group", { name: "Starter prompts" })
    ).not.toBeInTheDocument()
    expect(screen.getByText("Chat is unavailable.")).toBeInTheDocument()
  })

  it("renders a streaming reply as the transcript tail", () => {
    render(
      <ConversationPanel
        {...buildPanelControls()}
        completedMessages={[QUESTION]}
        kind="streaming-tail"
        streamingMessage={buildStreamingAssistantMessage(2, "A local")}
      />
    )

    expect(screen.getAllByRole("article").at(-1)).toHaveTextContent("A local")
    expect(
      screen.getByRole("status", { name: "Lys is generating" })
    ).toBeInTheDocument()
  })

  it("attaches the transcript host to the parent's ref and reports its scrolling", () => {
    const controls = buildPanelControls()
    render(
      <ConversationPanel
        {...controls}
        completedMessages={[QUESTION, ANSWER]}
        kind="completed-only"
      />
    )
    const host = controls.transcriptRef.current

    expect(host).toBeInstanceOf(HTMLDivElement)
    expect(
      screen.getByRole("region", { name: "Conversation" })
    ).toContainElement(host)

    fireEvent.scroll(host as HTMLDivElement)

    expect(controls.onTranscriptScroll).toHaveBeenCalledOnce()
  })

  it("offers Jump to latest only while the reader is away from the latest content", async () => {
    const controls = buildPanelControls()
    const user = userEvent.setup()
    const { rerender } = render(
      <ConversationPanel
        {...controls}
        completedMessages={[QUESTION, ANSWER]}
        isAtBottom={false}
        kind="completed-only"
      />
    )

    await user.click(screen.getByRole("button", { name: "Jump to latest" }))

    expect(controls.onJumpToLatest).toHaveBeenCalledOnce()

    rerender(
      <ConversationPanel
        {...controls}
        completedMessages={[QUESTION, ANSWER]}
        isAtBottom
        kind="completed-only"
      />
    )

    expect(
      screen.queryByRole("button", { name: "Jump to latest" })
    ).not.toBeInTheDocument()
  })

  it.each([
    ["generating-reply", "Lys is generating a reply"],
    ["opening-conversation", "Opening conversation"]
  ] as const)(
    "announces %s work in the status it keeps mounted",
    (activity, announcement) => {
      const { rerender } = render(
        <ConversationPanel
          {...buildPanelControls()}
          completedMessages={[QUESTION, ANSWER]}
          kind="completed-only"
        />
      )
      const status = screen.getByRole("status")
      expect(status).toHaveAttribute("aria-live", "polite")
      expect(status).toBeEmptyDOMElement()

      rerender(
        <ConversationPanel
          {...buildPanelControls()}
          activity={activity}
          completedMessages={[QUESTION, ANSWER]}
          kind="completed-only"
        />
      )

      expect(screen.getByRole("status")).toBe(status)
      expect(status).toHaveTextContent(announcement)
    }
  )

  it("marks the region busy only while a conversation is being opened", () => {
    const { rerender } = render(
      <ConversationPanel
        {...buildPanelControls()}
        activity="opening-conversation"
        completedMessages={[QUESTION, ANSWER]}
        kind="completed-only"
      />
    )

    expect(
      screen.getByRole("region", { name: "Conversation" })
    ).toHaveAttribute("aria-busy", "true")

    rerender(
      <ConversationPanel
        {...buildPanelControls()}
        activity="generating-reply"
        completedMessages={[QUESTION, ANSWER]}
        kind="completed-only"
      />
    )

    expect(
      screen.getByRole("region", { name: "Conversation" })
    ).toHaveAttribute("aria-busy", "false")
  })
})
