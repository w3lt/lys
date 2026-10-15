import type { ReactElement } from "react"

import {
  formatReasoningLabel,
  type ReplyReasoningPresentation
} from "./reply-presentation"

/** Properties accepted by {@link ReplyReasoning}. */
export type ReplyReasoningProps = {
  /** The reply's reasoning. */
  readonly reasoning: ReplyReasoningPresentation
}

/**
 * Presents a reply's reasoning as a disclosure that starts collapsed.
 *
 * @remarks Presentational. The summary reads `Thinking` while the reply
 * still streams its reasoning and `Thought for Ns` afterwards; opening it
 * shows the reasoning text as written. The native disclosure owns whether it
 * is open, so the reasoning stays open or closed as more of it streams in.
 * @param props - The reply's reasoning.
 * @returns The reasoning disclosure.
 */
export default function ReplyReasoning({
  reasoning
}: ReplyReasoningProps): ReactElement {
  return (
    <details className="chat-view__reasoning">
      <summary className="chat-view__disclosure">
        {formatReasoningLabel(reasoning)}
      </summary>
      <p className="chat-view__reasoning-text">{reasoning.text}</p>
    </details>
  )
}
