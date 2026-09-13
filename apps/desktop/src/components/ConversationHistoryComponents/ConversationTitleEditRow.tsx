import { MAXIMUM_CONVERSATION_TITLE_LENGTH } from "@lys/protocol"
import { useId, useState } from "react"
import type { FocusEvent, KeyboardEvent, ReactElement } from "react"

import type { ConversationExcerpt } from "@/lib/store/conversation-history"

import ConversationExcerptText from "./ConversationExcerptText"

/** Properties accepted by {@link ConversationTitleEditRow}. */
export type ConversationTitleEditRowProps = {
  /** Title placed in the field when editing starts; read only once. */
  readonly initialTitle: string
  /** Excerpt still shown beside the field. */
  readonly excerpt: ConversationExcerpt | null
  /** Parsed query of the displayed page; empty when not searching. */
  readonly highlightQuery: string
  /** Identifier of the visible hint describing the editing keys and limit. */
  readonly hintId: string
  /** Receives the draft when Enter submits it; focus should return to the row. */
  readonly onSubmitTitle: (draftTitle: string) => void
  /** Receives the draft when focus moves from the field to another element. */
  readonly onLeaveTitleField: (draftTitle: string) => void
  /** Requests that the parent abandon the edit; focus should return to the row. */
  readonly onCancelTitleEdit: () => void
}

/**
 * Edits one conversation's title in place within the history list.
 *
 * @remarks Primary category: interactive feature. The component owns only the
 * draft, seeded once from `initialTitle`; the parent decides whether a draft
 * becomes a rename. The field is labeled `rename conversation`, limited to the
 * protocol's title length, described by the panel hint, and focused when it
 * mounts because the user asked to rename. Enter submits the draft unless an
 * input method is composing text, Escape cancels, and moving focus to another
 * element reports the draft; Escape is consumed so the panel stays open. A
 * blur with no destination, such as the window losing focus or the field
 * being removed after a submit or cancel, reports nothing and keeps the edit.
 * @param props - Initial title, excerpt, hint, and the three edit endings.
 * @returns One history list item in title-editing mode.
 */
export default function ConversationTitleEditRow({
  initialTitle,
  excerpt,
  highlightQuery,
  hintId,
  onSubmitTitle,
  onLeaveTitleField,
  onCancelTitleEdit
}: ConversationTitleEditRowProps): ReactElement {
  const [draftTitle, setDraftTitle] = useState(initialTitle)
  const inputId = useId()

  /**
   * Submits on Enter and cancels on Escape.
   *
   * @param event - Key press observed on the title field.
   */
  function handleTitleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.nativeEvent.isComposing) return

    if (event.key === "Enter") {
      event.preventDefault()
      onSubmitTitle(draftTitle)
      return
    }
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      onCancelTitleEdit()
    }
  }

  /**
   * Reports the draft when focus moves to another element.
   *
   * @param event - Blur of the title field.
   */
  function handleTitleBlur(event: FocusEvent<HTMLInputElement>): void {
    if (event.relatedTarget === null) return

    onLeaveTitleField(draftTitle)
  }

  return (
    <li className="conversation-history__row" data-editing="">
      <span className="conversation-history__rename">
        <label className="conversation-history__rename-label" htmlFor={inputId}>
          rename <span className="sr-only">conversation</span>
        </label>
        <input
          aria-describedby={hintId}
          autoFocus
          className="conversation-history__rename-input"
          id={inputId}
          maxLength={MAXIMUM_CONVERSATION_TITLE_LENGTH}
          onBlur={handleTitleBlur}
          onChange={(event) => setDraftTitle(event.currentTarget.value)}
          onKeyDown={handleTitleKeyDown}
          spellCheck={false}
          type="text"
          value={draftTitle}
        />
      </span>
      <ConversationExcerptText
        excerpt={excerpt}
        highlightQuery={highlightQuery}
      />
    </li>
  )
}
