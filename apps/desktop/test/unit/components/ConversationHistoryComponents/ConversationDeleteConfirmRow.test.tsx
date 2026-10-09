import { fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import ConversationDeleteConfirmRow from "@/components/ConversationHistoryComponents/ConversationDeleteConfirmRow"

/**
 * Renders the confirmation inside a list, with a container that records the
 * key presses reaching it.
 *
 * @returns The two outcomes' spies and the container's key spy.
 */
function renderDeleteConfirmRow() {
  const onConfirmDelete = vi.fn()
  const onCancelDelete = vi.fn()
  const onPanelKeyDown = vi.fn()
  render(
    <div onKeyDown={onPanelKeyDown}>
      <ul>
        <ConversationDeleteConfirmRow
          onCancelDelete={onCancelDelete}
          onConfirmDelete={onConfirmDelete}
          title="Streaming pipeline"
        />
      </ul>
    </div>
  )
  return { onConfirmDelete, onCancelDelete, onPanelKeyDown }
}

describe("ConversationDeleteConfirmRow", () => {
  it("asks in a named group and starts on Keep", () => {
    renderDeleteConfirmRow()

    const prompt = screen.getByRole("group", {
      name: "Delete Streaming pipeline for good?"
    })
    expect(within(prompt).getByRole("button", { name: "Keep" })).toHaveFocus()
    expect(screen.getByRole("listitem")).toHaveTextContent("Streaming pipeline")
  })

  it("keeps the conversation on Keep", async () => {
    const { onCancelDelete, onConfirmDelete } = renderDeleteConfirmRow()
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: "Keep" }))

    expect(onCancelDelete).toHaveBeenCalledOnce()
    expect(onConfirmDelete).not.toHaveBeenCalled()
  })

  it("deletes once per press of Delete", async () => {
    const { onCancelDelete, onConfirmDelete } = renderDeleteConfirmRow()
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: "Delete" }))

    expect(onConfirmDelete).toHaveBeenCalledOnce()
    expect(onCancelDelete).not.toHaveBeenCalled()
  })

  it.each(["Keep", "Delete"])(
    "keeps the conversation on Escape from %s without the key reaching the panel",
    (choice) => {
      const { onCancelDelete, onConfirmDelete, onPanelKeyDown } =
        renderDeleteConfirmRow()

      fireEvent.keyDown(screen.getByRole("button", { name: choice }), {
        key: "Escape"
      })

      expect(onCancelDelete).toHaveBeenCalledOnce()
      expect(onConfirmDelete).not.toHaveBeenCalled()
      expect(onPanelKeyDown).not.toHaveBeenCalled()
    }
  )
})
