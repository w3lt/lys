import type { KeyboardEvent, ReactElement } from "react"

import { Button } from "@/components/ui/button"

/** Properties accepted by {@link ConversationDeleteConfirmRow}. */
export type ConversationDeleteConfirmRowProps = {
  /** Displayed title of the conversation awaiting confirmation. */
  readonly title: string
  /** Requests that the parent permanently delete the conversation. */
  readonly onConfirmDelete: () => void
  /** Requests that the parent keep the conversation. */
  readonly onCancelDelete: () => void
}

/**
 * Asks whether to permanently delete one listed conversation.
 *
 * @remarks Primary category: presentational. The parent owns the decision and
 * the deletion; the component owns no state, effect, or resource. The prompt
 * is a group named `Delete <title> for good?`. Focus starts on Keep, the least
 * destructive choice, when the row mounts because the user asked to delete.
 * Keep and Escape request keeping the conversation; Escape is consumed so the
 * panel stays open. Delete requests deletion once per activation.
 * @param props - Title and the two confirmation outcomes.
 * @returns One history list item in delete-confirmation mode.
 */
export default function ConversationDeleteConfirmRow({
  title,
  onConfirmDelete,
  onCancelDelete
}: ConversationDeleteConfirmRowProps): ReactElement {
  /**
   * Keeps the conversation when Escape is pressed inside the prompt.
   *
   * @param event - Key press observed on either confirmation button, the
   * prompt's only focusable elements.
   */
  function handleConfirmationKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key !== "Escape") return

    event.preventDefault()
    event.stopPropagation()
    onCancelDelete()
  }

  return (
    <li className="conversation-history__row" data-confirming="">
      <span className="conversation-history__title">{title}</span>
      <fieldset
        aria-label={`Delete ${title} for good?`}
        className="conversation-history__confirm"
      >
        <div className="conversation-history__confirm-choices">
          <span
            aria-hidden="true"
            className="conversation-history__confirm-text"
          >
            delete for good?
          </span>
          <Button
            autoFocus
            onClick={onCancelDelete}
            onKeyDown={handleConfirmationKeyDown}
            size="sm"
            type="button"
            variant="outline"
          >
            Keep
          </Button>
          <Button
            onClick={onConfirmDelete}
            onKeyDown={handleConfirmationKeyDown}
            size="sm"
            type="button"
            variant="destructive"
          >
            Delete
          </Button>
        </div>
      </fieldset>
    </li>
  )
}
