import { createRef } from "react"
import { fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import ConversationHistoryRow, {
  type ConversationRowPendingOperation
} from "@/components/ConversationHistoryComponents/ConversationHistoryRow"
import type { ConversationHistoryEntry } from "@/lib/store/conversation-history"
import { createFixtureUuidV7 } from "../../support/conversationFixtures"

/** History opened at 9 October 2026, 14:30 local time. */
const OPENED_AT_MS = new Date(2026, 9, 9, 14, 30).getTime()

/** Listed conversation last active five minutes before history opened. */
const ENTRY: ConversationHistoryEntry = Object.freeze({
  id: createFixtureUuidV7(1),
  title: "Streaming pipeline",
  updatedAt: new Date(2026, 9, 9, 14, 25).toISOString(),
  excerpt: Object.freeze({ speaker: "user", text: "Sketch the pipeline" })
})

/**
 * Renders one row with spies for every action.
 *
 * @param options - The row facts a case varies.
 * @returns The row's action spies and the open-button ref.
 */
function renderRow(
  options: {
    readonly entry?: ConversationHistoryEntry
    readonly isOpenInChat?: boolean
    readonly pendingOperation?: ConversationRowPendingOperation
  } = {}
) {
  const actions = {
    onOpenConversation: vi.fn(),
    onFocusNextConversation: vi.fn(),
    onFocusPreviousConversation: vi.fn(),
    onStartTitleEdit: vi.fn(),
    onRequestDelete: vi.fn()
  }
  const openButtonRef = createRef<HTMLButtonElement>()
  render(
    <ul>
      <ConversationHistoryRow
        {...actions}
        entry={options.entry ?? ENTRY}
        highlightQuery=""
        isOpenInChat={options.isOpenInChat ?? false}
        openButtonRef={openButtonRef}
        pendingOperation={options.pendingOperation ?? "none"}
        referenceTimeMs={OPENED_AT_MS}
      />
    </ul>
  )
  return { ...actions, openButtonRef }
}

/**
 * Gets the row's open button.
 *
 * @param title - Displayed title, which starts its name.
 * @returns The open button.
 */
function getOpenButton(title = "Streaming pipeline"): HTMLElement {
  return screen.getByRole("button", { name: new RegExp(`^${title}`) })
}

describe("ConversationHistoryRow", () => {
  it("opens the conversation from a button holding its title, excerpt, and time", async () => {
    const { onOpenConversation, openButtonRef } = renderRow()
    const user = userEvent.setup()

    const openButton = getOpenButton()
    expect(openButton).toHaveTextContent(
      "Streaming pipelineyou: Sketch the pipeline5m"
    )
    expect(within(openButton).getByText("5m")).toHaveAttribute(
      "datetime",
      ENTRY.updatedAt
    )
    expect(openButtonRef.current).toBe(openButton)

    await user.click(openButton)

    expect(onOpenConversation).toHaveBeenCalledOnce()
  })

  it("titles an untitled conversation Untitled", () => {
    renderRow({ entry: { ...ENTRY, title: null } })

    expect(getOpenButton("Untitled")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Rename Untitled" })
    ).toBeInTheDocument()
  })

  it("marks the conversation the chat view presents", () => {
    renderRow({ isOpenInChat: true })

    const openButton = getOpenButton()
    expect(openButton).toHaveAttribute("aria-current", "true")
    expect(within(openButton).getByText("open")).toBeInTheDocument()
  })

  it("marks no other conversation as presented", () => {
    renderRow()

    expect(getOpenButton()).not.toHaveAttribute("aria-current")
    expect(screen.queryByText("open")).not.toBeInTheDocument()
  })

  it("asks to move focus on Arrow Down and Arrow Up, and to rename on F2", () => {
    const actions = renderRow()

    fireEvent.keyDown(getOpenButton(), { key: "ArrowDown" })
    fireEvent.keyDown(getOpenButton(), { key: "ArrowUp" })
    fireEvent.keyDown(getOpenButton(), { key: "F2" })

    expect(actions.onFocusNextConversation).toHaveBeenCalledOnce()
    expect(actions.onFocusPreviousConversation).toHaveBeenCalledOnce()
    expect(actions.onStartTitleEdit).toHaveBeenCalledOnce()
  })

  it("offers renaming and deleting with buttons named after the title", async () => {
    const { onStartTitleEdit, onRequestDelete } = renderRow()
    const user = userEvent.setup()

    await user.click(
      screen.getByRole("button", { name: "Rename Streaming pipeline" })
    )
    await user.click(
      screen.getByRole("button", { name: "Delete Streaming pipeline" })
    )

    expect(onStartTitleEdit).toHaveBeenCalledOnce()
    expect(onRequestDelete).toHaveBeenCalledOnce()
  })

  it("shows a pending rename in words, marks the row busy, and keeps it openable", async () => {
    const { onOpenConversation, onStartTitleEdit } = renderRow({
      pendingOperation: "update-title"
    })
    const user = userEvent.setup()

    expect(screen.getByRole("listitem")).toHaveAttribute("aria-busy", "true")
    expect(screen.getByText("renaming…")).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /^(Rename|Delete) / })
    ).not.toBeInTheDocument()

    fireEvent.keyDown(getOpenButton(), { key: "F2" })
    await user.click(getOpenButton())

    expect(onStartTitleEdit).not.toHaveBeenCalled()
    expect(onOpenConversation).toHaveBeenCalledOnce()
  })

  it("shows a pending deletion in words and stops opening the conversation", async () => {
    const { onOpenConversation } = renderRow({ pendingOperation: "delete" })
    const user = userEvent.setup()

    expect(screen.getByText("deleting…")).toBeInTheDocument()
    expect(getOpenButton()).toBeDisabled()

    await user.click(getOpenButton())

    expect(onOpenConversation).not.toHaveBeenCalled()
  })
})
