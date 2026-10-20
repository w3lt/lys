import type { ReactElement } from "react"

import {
  formatReplyControlName,
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
  /** One-based position of the reply among the transcript's replies. */
  readonly replyNumber: number
}

/** Properties accepted by {@link ReplyStep}. */
type ReplyStepProps = {
  /** One round that called tools. */
  readonly step: ReplyStepPresentation
  /** One-based position of the step's reply among the transcript's replies. */
  readonly replyNumber: number
}

/**
 * Presents one step of a reply: the text its round wrote, when it wrote any,
 * and its calls.
 *
 * @remarks The calls form a list named `Tool calls`, in the model's order,
 * each a {@link ToolCallStep} keyed by the call's identifier.
 * @param props - The step and its reply's position.
 * @returns The step's text and call list.
 */
function ReplyStep({ step, replyNumber }: ReplyStepProps): ReactElement {
  return (
    <>
      {step.text !== "" && <p className="chat-view__step-text">{step.text}</p>}
      <ul aria-label="Tool calls" className="chat-view__call-list">
        {step.calls.map((call) => (
          <li key={call.id}>
            <ToolCallStep call={call} replyNumber={replyNumber} />
          </li>
        ))}
      </ul>
    </>
  )
}

/**
 * Presents the steps a reply took as a disclosure that starts collapsed.
 *
 * @remarks The summary counts the steps and tool calls and, once the reply
 * ended, says how long it worked; its name adds the reply. Opening it shows
 * a list named `Steps`, one item per step keyed by its round, each showing
 * the text its round wrote and its calls. The native disclosure owns whether
 * it is open.
 * @param props - The steps, how long the reply worked, and its position.
 * @returns The steps disclosure.
 */
export default function ReplySteps({
  steps,
  workedMs,
  replyNumber
}: ReplyStepsProps): ReactElement {
  const label = formatReplyStepsLabel(steps, workedMs)

  return (
    <details className="chat-view__steps">
      <summary
        aria-label={formatReplyControlName(label, replyNumber)}
        className="chat-view__disclosure"
      >
        {label}
      </summary>
      <ol aria-label="Steps" className="chat-view__step-list">
        {steps.map((step) => (
          <li className="chat-view__step" key={step.round}>
            <ReplyStep replyNumber={replyNumber} step={step} />
          </li>
        ))}
      </ol>
    </details>
  )
}
