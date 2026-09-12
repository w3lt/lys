import type { ReactElement } from "react"

import { Button } from "@/components/ui/button"

/** Properties accepted by {@link ConversationHistoryNotice}. */
export type ConversationHistoryNoticeProps =
  | {
      /** Selects a message with no action. */
      readonly kind: "message"
      /** Loading, empty, or no-match message shown instead of rows. */
      readonly message: string
    }
  | {
      /** Selects a failure message with a retry action. */
      readonly kind: "failure"
      /** User-presentable failure shown instead of rows. */
      readonly message: string
      /** Requests that the parent read the list again. */
      readonly onRetryConversationHistory: () => void
    }

/**
 * Presents the message shown in place of history rows.
 *
 * @remarks Primary category: presentational. The parent owns the message and
 * the retry; the component owns no state, effect, or resource. The message is
 * a polite status, so a loading, empty, no-match, or failed outcome is
 * announced without moving focus. The failure variant adds a Try again button
 * that requests one new read per activation.
 * @param props - Message and, for failures, the retry request.
 * @returns The notice filling the history list region.
 */
export default function ConversationHistoryNotice(
  props: ConversationHistoryNoticeProps
): ReactElement {
  return (
    <div className="conversation-history__notice">
      <p role="status">{props.message}</p>
      {props.kind === "failure" ? (
        <Button
          onClick={props.onRetryConversationHistory}
          size="sm"
          type="button"
          variant="outline"
        >
          Try again
        </Button>
      ) : null}
    </div>
  )
}
