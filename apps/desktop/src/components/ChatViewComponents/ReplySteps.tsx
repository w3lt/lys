import type { ReactElement } from "react"

import {
  formatReplyStepsLabel,
  type ReplyStepPresentation
} from "./reply-presentation"
import ToolCallStep from "./ToolCallStep"

/** Properties accepted by {@link ReplySteps}. */
export type ReplyStepsProps = {
  /** The reply's rounds that called tools, in order; at least one. */
  readonly steps: readonly ReplyStepPresentation[]
  /** Milliseconds the ended reply took; undefined while it streams. */
  readonly workedMs: number | undefined
}

/**
 * Presents the steps a reply took as a disclosure that starts collapsed.
 *
 * @remarks Presentational. The summary counts the steps and tool calls and,
 * once the reply ended, says how long it worked; opening it lists each step
 * with the text its round wrote and its calls, each a {@link ToolCallStep}.
 * The native disclosure owns whether it is open.
 * @param props - The steps and how long the reply worked.
 * @returns The steps disclosure.
 */
export default function ReplySteps({
  steps,
  workedMs
}: ReplyStepsProps): ReactElement {
  return (
    <details className="chat-view__steps">
      <summary className="chat-view__disclosure">
        {formatReplyStepsLabel(steps, workedMs)}
      </summary>
      <ol className="chat-view__step-list">
        {steps.map((step) => (
          <li className="chat-view__step" key={step.round}>
            {step.text !== "" && (
              <p className="chat-view__step-text">{step.text}</p>
            )}
            <ul className="chat-view__call-list">
              {step.calls.map((call) => (
                <li key={call.id}>
                  <ToolCallStep call={call} />
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </details>
  )
}
