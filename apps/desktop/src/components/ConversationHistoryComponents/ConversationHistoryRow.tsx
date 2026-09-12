import { Pencil, X } from "lucide-react"
import type { KeyboardEvent, ReactElement, Ref } from "react"

import type {
  ConversationHistoryEntry,
  ConversationHistoryMutation
} from "@/lib/store/conversation-history"

import ConversationExcerptText from "./ConversationExcerptText"
import {
  formatConversationTime,
  formatConversationTitle
} from "./conversation-history-presentation"

/** Change awaiting its backend outcome for a row, or none. */
export type ConversationRowPendingOperation =
  ConversationHistoryMutation["operation"] | "none"

/** Properties accepted by {@link ConversationHistoryRow}. */
export type ConversationHistoryRowProps = {
  /** Listed conversation shown by the row. */
  readonly entry: ConversationHistoryEntry
  /** Parsed query of the displayed page; empty when not searching. */
  readonly highlightQuery: string
  /** Epoch milliseconds the row's relative time is measured from. */
  readonly referenceTimeMs: number
  /** Whether the chat view presents this conversation. */
  readonly isOpenInChat: boolean
  /** Change to this conversation awaiting its backend outcome. */
  readonly pendingOperation: ConversationRowPendingOperation
  /** Parent-owned ref to the open button, used to move focus between rows. */
  readonly openButtonRef: Ref<HTMLButtonElement>
  /** Requests that the parent open this conversation in the chat view. */
  readonly onOpenConversation: () => void
  /** Requests that the parent move focus to the next row. */
  readonly onFocusNextConversation: () => void
  /** Requests that the parent move focus to the previous row or the search. */
  readonly onFocusPreviousConversation: () => void
  /** Requests that the parent start editing this conversation's title. */
  readonly onStartTitleEdit: () => void
  /** Requests that the parent ask whether to delete this conversation. */
  readonly onRequestDelete: () => void
}

/**
 * Presents one listed conversation with its open, rename, and delete actions.
 *
 * @remarks Primary category: presentational. The parent owns the entry, the
 * pending change, focus movement, and every requested action; the component
 * owns no state, effect, or resource. The native open button contains the
 * title, an `open` tag and `aria-current` when the chat view presents the
 * conversation, the excerpt, and the relative time, so its name starts with
 * the title. Arrow Down and Arrow Up on it request moving focus, and F2
 * requests renaming. Rename and delete are sibling buttons named after the
 * title; they are always focusable and styling reveals them on hover or focus
 * within the row. While a change is pending they are replaced by visible
 * progress text and the row is marked busy; a pending deletion also disables
 * opening.
 * @param props - Entry, presentation context, focus ref, and row actions.
 * @returns One history list item.
 */
export default function ConversationHistoryRow({
  entry,
  highlightQuery,
  referenceTimeMs,
  isOpenInChat,
  pendingOperation,
  openButtonRef,
  onOpenConversation,
  onFocusNextConversation,
  onFocusPreviousConversation,
  onStartTitleEdit,
  onRequestDelete
}: ConversationHistoryRowProps): ReactElement {
  const title = formatConversationTitle(entry)
  const timeLabel = formatConversationTime(entry.updatedAt, referenceTimeMs)
  const isPending = pendingOperation !== "none"
  const pendingLabel = pendingOperation === "delete" ? "deleting…" : "renaming…"

  /**
   * Translates row navigation and rename keys into parent requests.
   *
   * @param event - Key press observed on the open button.
   */
  function handleOpenButtonKeyDown(
    event: KeyboardEvent<HTMLButtonElement>
  ): void {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault()
        onFocusNextConversation()
        return
      case "ArrowUp":
        event.preventDefault()
        onFocusPreviousConversation()
        return
      case "F2":
        if (isPending) return
        event.preventDefault()
        onStartTitleEdit()
        return
    }
  }

  return (
    <li
      aria-busy={isPending}
      className="conversation-history__row"
      data-current={isOpenInChat ? "" : undefined}
      data-pending={isPending ? "" : undefined}
    >
      <button
        aria-current={isOpenInChat ? "true" : undefined}
        className="conversation-history__open"
        disabled={pendingOperation === "delete"}
        onClick={onOpenConversation}
        onKeyDown={handleOpenButtonKeyDown}
        ref={openButtonRef}
        type="button"
      >
        <span className="conversation-history__title-line">
          <span className="conversation-history__title">{title}</span>
          {isOpenInChat ? (
            <span className="conversation-history__tag">open</span>
          ) : null}
        </span>
        <ConversationExcerptText
          excerpt={entry.excerpt}
          highlightQuery={highlightQuery}
        />
        <time className="conversation-history__time" dateTime={entry.updatedAt}>
          {timeLabel}
        </time>
      </button>
      {isPending ? (
        <span className="conversation-history__pending">{pendingLabel}</span>
      ) : (
        <span className="conversation-history__actions">
          <button
            aria-label={`Rename ${title}`}
            className="conversation-history__icon-button"
            onClick={onStartTitleEdit}
            type="button"
          >
            <Pencil aria-hidden="true" />
          </button>
          <button
            aria-label={`Delete ${title}`}
            className="conversation-history__icon-button"
            data-tone="danger"
            onClick={onRequestDelete}
            type="button"
          >
            <X aria-hidden="true" />
          </button>
        </span>
      )}
    </li>
  )
}
