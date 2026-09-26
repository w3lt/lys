import { MAXIMUM_CONVERSATION_SEARCH_QUERY_LENGTH } from "@lys/protocol"
import { X } from "lucide-react"
import { useId } from "react"
import type { KeyboardEvent, ReactElement, RefObject } from "react"

/** Properties accepted by {@link ConversationSearchField}. */
export type ConversationSearchFieldProps = {
  /** Search text owned by the parent, shown exactly as typed. */
  readonly query: string
  /** Result count for the displayed list, or empty text before one loads. */
  readonly resultCountLabel: string
  /** Identifier of the visible hint describing keyboard use. */
  readonly hintId: string
  /** Parent-owned ref to the search input, the panel's initial focus target. */
  readonly searchFieldRef: RefObject<HTMLInputElement | null>
  /** Receives a proposed replacement for the parent-owned search text. */
  readonly onQueryChange: (query: string) => void
  /** Requests that the parent open the first listed conversation. */
  readonly onOpenFirstConversation: () => void
  /** Requests that the parent move focus to the first listed conversation. */
  readonly onFocusFirstConversation: () => void
  /** Requests that the parent close conversation history. */
  readonly onCloseConversationHistory: () => void
}

/**
 * Presents the labeled search field that filters past conversations.
 *
 * @remarks Primary category: presentational. The parent owns the search text,
 * the count, and every requested action; the component owns no state, effect,
 * or resource. The input is a native search field labeled `recall past
 * conversations`, bounded by the protocol's query length, and described by
 * the panel hint. Arrow Down asks the parent to focus the first result and
 * Enter asks it to open the first result, except while an input method is
 * composing text. Escape clears non-empty text, otherwise asks the parent to
 * close history; either way the field consumes it so the panel does not
 * handle it again. The clear button appears only with text, empties it, and
 * returns focus to the input. The count is a polite status region that is
 * always present, so count changes are announced.
 * @param props - Parent-owned search text, count, focus target, and actions.
 * @returns The search field row at the top of the history panel.
 */
export default function ConversationSearchField({
  query,
  resultCountLabel,
  hintId,
  searchFieldRef,
  onQueryChange,
  onOpenFirstConversation,
  onFocusFirstConversation,
  onCloseConversationHistory
}: ConversationSearchFieldProps): ReactElement {
  const inputId = useId()

  /**
   * Clears non-empty text, or asks to close history when already empty.
   *
   * @param event - Escape key press consumed by the field.
   */
  function handleSearchEscape(event: KeyboardEvent<HTMLInputElement>): void {
    event.preventDefault()
    event.stopPropagation()
    if (query === "") {
      onCloseConversationHistory()
      return
    }

    onQueryChange("")
  }

  /**
   * Translates the field's navigation keys into parent requests.
   *
   * @param event - Key press observed on the search input.
   */
  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.nativeEvent.isComposing) return

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault()
        onFocusFirstConversation()
        return
      case "Enter":
        event.preventDefault()
        onOpenFirstConversation()
        return
      case "Escape":
        handleSearchEscape(event)
        return
    }
  }

  /** Empties the search text and keeps focus in the field. */
  function handleClearClick(): void {
    searchFieldRef.current?.focus()
    onQueryChange("")
  }

  return (
    <div className="conversation-history__search">
      <label className="conversation-history__search-label" htmlFor={inputId}>
        recall <span className="sr-only">past conversations</span>
      </label>
      <input
        aria-describedby={hintId}
        autoComplete="off"
        className="conversation-history__search-input"
        id={inputId}
        maxLength={MAXIMUM_CONVERSATION_SEARCH_QUERY_LENGTH}
        onChange={(event) => onQueryChange(event.currentTarget.value)}
        onKeyDown={handleSearchKeyDown}
        placeholder="Search every word kept here"
        ref={searchFieldRef}
        spellCheck={false}
        type="search"
        value={query}
      />
      {query === "" ? null : (
        <button
          aria-label="Clear search"
          className="conversation-history__icon-button"
          onClick={handleClearClick}
          type="button"
        >
          <X aria-hidden="true" />
        </button>
      )}
      <span className="conversation-history__count" role="status">
        {resultCountLabel}
      </span>
    </div>
  )
}
