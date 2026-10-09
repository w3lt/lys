import { MAXIMUM_CONVERSATION_SEARCH_QUERY_LENGTH } from "@lys/protocol"
import { createRef } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import ConversationSearchField from "@/components/ConversationHistoryComponents/ConversationSearchField"

/**
 * Renders the search field inside a container that records the key presses
 * reaching it, as the history panel would.
 *
 * @param query - Search text owned by the parent.
 * @returns The field's callbacks, the container's key spy, and the input ref.
 */
function renderSearchField(query: string) {
  const callbacks = {
    onQueryChange: vi.fn(),
    onOpenFirstConversation: vi.fn(),
    onFocusFirstConversation: vi.fn(),
    onCloseConversationHistory: vi.fn()
  }
  const onPanelKeyDown = vi.fn()
  const searchFieldRef = createRef<HTMLInputElement>()
  render(
    <div onKeyDown={onPanelKeyDown}>
      <ConversationSearchField
        {...callbacks}
        hintId="history-hint"
        query={query}
        resultCountLabel="3 of 12"
        searchFieldRef={searchFieldRef}
      />
      <p id="history-hint">Arrows move</p>
    </div>
  )
  return { ...callbacks, onPanelKeyDown, searchFieldRef }
}

/**
 * Gets the search input.
 *
 * @returns The labelled search box.
 */
function getSearchBox(): HTMLElement {
  return screen.getByRole("searchbox", { name: "recall past conversations" })
}

describe("ConversationSearchField", () => {
  it("is a labelled, bounded search box described by the panel hint", () => {
    const { searchFieldRef } = renderSearchField("lys")

    const searchBox = getSearchBox()
    expect(searchBox).toHaveValue("lys")
    expect(searchBox).toHaveAttribute(
      "maxLength",
      String(MAXIMUM_CONVERSATION_SEARCH_QUERY_LENGTH)
    )
    expect(searchBox).toHaveAccessibleDescription("Arrows move")
    expect(searchFieldRef.current).toBe(searchBox)
  })

  it("proposes the text exactly as typed", async () => {
    const { onQueryChange } = renderSearchField("")
    const user = userEvent.setup()

    await user.type(getSearchBox(), "L")

    expect(onQueryChange).toHaveBeenCalledExactlyOnceWith("L")
  })

  it("moves to the first result on Arrow Down and opens it on Enter", () => {
    const { onFocusFirstConversation, onOpenFirstConversation } =
      renderSearchField("lys")

    fireEvent.keyDown(getSearchBox(), { key: "ArrowDown" })
    fireEvent.keyDown(getSearchBox(), { key: "Enter" })

    expect(onFocusFirstConversation).toHaveBeenCalledOnce()
    expect(onOpenFirstConversation).toHaveBeenCalledOnce()
  })

  it("ignores Arrow Down and Enter while an input method composes text", () => {
    const { onFocusFirstConversation, onOpenFirstConversation } =
      renderSearchField("ly")

    fireEvent.keyDown(getSearchBox(), { key: "ArrowDown", isComposing: true })
    fireEvent.keyDown(getSearchBox(), { key: "Enter", isComposing: true })

    expect(onFocusFirstConversation).not.toHaveBeenCalled()
    expect(onOpenFirstConversation).not.toHaveBeenCalled()
  })

  it("clears typed text on Escape without closing history or reaching the panel", () => {
    const { onQueryChange, onCloseConversationHistory, onPanelKeyDown } =
      renderSearchField("lys")

    fireEvent.keyDown(getSearchBox(), { key: "Escape" })

    expect(onQueryChange).toHaveBeenCalledExactlyOnceWith("")
    expect(onCloseConversationHistory).not.toHaveBeenCalled()
    expect(onPanelKeyDown).not.toHaveBeenCalled()
  })

  it("closes history on Escape once the search is empty, without reaching the panel", () => {
    const { onQueryChange, onCloseConversationHistory, onPanelKeyDown } =
      renderSearchField("")

    fireEvent.keyDown(getSearchBox(), { key: "Escape" })

    expect(onCloseConversationHistory).toHaveBeenCalledOnce()
    expect(onQueryChange).not.toHaveBeenCalled()
    expect(onPanelKeyDown).not.toHaveBeenCalled()
  })

  it("offers clearing only while there is text, and keeps focus in the field", async () => {
    const { onQueryChange } = renderSearchField("lys")
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: "Clear search" }))

    expect(onQueryChange).toHaveBeenCalledExactlyOnceWith("")
    expect(getSearchBox()).toHaveFocus()
  })

  it("shows no clear button for an empty search", () => {
    renderSearchField("")

    expect(
      screen.queryByRole("button", { name: "Clear search" })
    ).not.toBeInTheDocument()
  })

  it("announces the result count politely", () => {
    renderSearchField("lys")

    const count = screen.getByRole("status")
    expect(count).toHaveTextContent("3 of 12")
    expect(count).toHaveAttribute("aria-live", "polite")
  })
})
