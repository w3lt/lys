import { MAXIMUM_CONVERSATION_TITLE_LENGTH } from "@lys/protocol"
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import ConversationTitleEditRow from "@/components/ConversationHistoryComponents/ConversationTitleEditRow"

/**
 * Renders the edit row inside a list beside another focusable control, with
 * a container that records the key presses reaching it.
 *
 * @param draftTitle - Draft owned by the parent.
 * @returns The row's callbacks and the container's key spy.
 */
function startTitleEditRow(draftTitle: string) {
  const callbacks = {
    onDraftTitleChange: vi.fn(),
    onSubmitTitle: vi.fn(),
    onLeaveTitleField: vi.fn(),
    onCancelTitleEdit: vi.fn()
  }
  const onPanelKeyDown = vi.fn()
  render(
    <div onKeyDown={onPanelKeyDown}>
      <ul>
        <ConversationTitleEditRow
          {...callbacks}
          draftTitle={draftTitle}
          excerpt={{ speaker: "assistant", text: "A local chat app." }}
          highlightQuery=""
          hintId="history-hint"
        />
      </ul>
      <p id="history-hint">Enter saves</p>
      <button type="button">Elsewhere</button>
    </div>
  )
  return { ...callbacks, onPanelKeyDown }
}

/**
 * Gets the title field.
 *
 * @returns The labelled rename input.
 */
function getTitleField(): HTMLElement {
  return screen.getByRole("textbox", { name: "rename conversation" })
}

describe("ConversationTitleEditRow", () => {
  it("focuses a labelled, bounded field holding the draft, beside the excerpt", () => {
    startTitleEditRow("Streaming pipeline")

    const field = getTitleField()
    expect(field).toHaveFocus()
    expect(field).toHaveValue("Streaming pipeline")
    expect(field).toHaveAttribute(
      "maxLength",
      String(MAXIMUM_CONVERSATION_TITLE_LENGTH)
    )
    expect(field).toHaveAccessibleDescription("Enter saves")
    expect(screen.getByRole("listitem")).toHaveTextContent("A local chat app.")
  })

  it("proposes each edit", async () => {
    const { onDraftTitleChange } = startTitleEditRow("Streaming")
    const user = userEvent.setup()

    await user.type(getTitleField(), "!")

    expect(onDraftTitleChange).toHaveBeenCalledExactlyOnceWith("Streaming!")
  })

  it("submits the draft on Enter, except while an input method composes text", () => {
    const { onSubmitTitle } = startTitleEditRow("New title")

    fireEvent.keyDown(getTitleField(), { key: "Enter", isComposing: true })
    expect(onSubmitTitle).not.toHaveBeenCalled()

    fireEvent.keyDown(getTitleField(), { key: "Enter" })
    expect(onSubmitTitle).toHaveBeenCalledExactlyOnceWith("New title")
  })

  it("cancels on Escape without the key reaching the panel", () => {
    const { onCancelTitleEdit, onPanelKeyDown } = startTitleEditRow("Draft")

    fireEvent.keyDown(getTitleField(), { key: "Escape" })

    expect(onCancelTitleEdit).toHaveBeenCalledOnce()
    expect(onPanelKeyDown).not.toHaveBeenCalled()
  })

  it("reports the draft when focus moves to another element", async () => {
    const { onLeaveTitleField } = startTitleEditRow("Draft")
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: "Elsewhere" }))

    expect(onLeaveTitleField).toHaveBeenCalledExactlyOnceWith("Draft")
  })

  it("keeps the edit when focus leaves for no element, as when the window blurs", () => {
    const { onLeaveTitleField, onSubmitTitle, onCancelTitleEdit } =
      startTitleEditRow("Draft")

    fireEvent.blur(getTitleField(), { relatedTarget: null })

    expect(onLeaveTitleField).not.toHaveBeenCalled()
    expect(onSubmitTitle).not.toHaveBeenCalled()
    expect(onCancelTitleEdit).not.toHaveBeenCalled()
  })
})
