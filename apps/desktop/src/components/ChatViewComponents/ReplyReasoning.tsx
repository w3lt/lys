import type { ReactElement } from "react"

import {
  formatReasoningLabel,
  formatReplyControlName,
  type ReplyReasoningPresentation
} from "./reply-presentation"

/** Properties accepted by {@link ReplyReasoning}. */
export type ReplyReasoningProps = {
  /** The reply's reasoning. */
  readonly reasoning: ReplyReasoningPresentation
  /** One-based position of the reply among the transcript's replies. */
  readonly replyNumber: number
}

/**
 * Presents a reply's reasoning as a disclosure that starts collapsed.
 *
 * @remarks The summary reads `Thinking` while the reply still streams its
 * reasoning and `Thought for Ns` afterwards, and its name adds the reply,
 * such as `Thought for 3s, reply 2`; opening it shows the reasoning text as
 * written. The native disclosure owns whether it is open, so the reasoning
 * stays open or closed as more of it streams in.
 * @param props - The reply's reasoning and position.
 * @returns The reasoning disclosure.
 */
export default function ReplyReasoning({
  reasoning,
  replyNumber
}: ReplyReasoningProps): ReactElement {
  const label = formatReasoningLabel(reasoning)

  return (
    <details className="chat-view__reasoning">
      <summary
        aria-label={formatReplyControlName(label, replyNumber)}
        className="chat-view__disclosure"
      >
        {label}
      </summary>
      <p className="chat-view__reasoning-text">{reasoning.text}</p>
    </details>
  )
}
