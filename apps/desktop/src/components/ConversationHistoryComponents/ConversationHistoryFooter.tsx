import type { ReactElement } from "react"

import { Button } from "@/components/ui/button"

/** Properties accepted by {@link ConversationHistoryFooter}. */
export type ConversationHistoryFooterProps = {
  /** Keyboard guidance for the current interaction. */
  readonly hint: string
  /** Identifier given to the hint so fields can reference it. */
  readonly hintId: string
  /** Latest rename or deletion failure, or undefined when there is none. */
  readonly mutationError: string | undefined
  /** Requests that the parent start a new conversation. */
  readonly onStartConversation: () => void
}

/**
 * Presents the history panel's keyboard hint, change failures, and new
 * conversation action.
 *
 * @remarks Primary category: presentational. The parent owns the hint, the
 * failure, and starting a conversation; the component owns no state, effect,
 * or resource. The failure is shown in a polite status region that is always
 * present, so a new failure is announced without moving focus. Start a new
 * one requests a new conversation once per activation.
 * @param props - Hint, failure, and the start action.
 * @returns The foot of the history panel.
 */
export default function ConversationHistoryFooter({
  hint,
  hintId,
  mutationError,
  onStartConversation
}: ConversationHistoryFooterProps): ReactElement {
  return (
    <div className="conversation-history__footer">
      <p className="conversation-history__error" role="status">
        {mutationError}
      </p>
      <div className="conversation-history__footer-row">
        <p className="conversation-history__hint" id={hintId}>
          {hint}
        </p>
        <Button
          onClick={onStartConversation}
          size="sm"
          type="button"
          variant="outline"
        >
          Start a new one
        </Button>
      </div>
    </div>
  )
}
