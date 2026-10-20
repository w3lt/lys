import type { ToolCallReplyPart } from "@lys/share"
import type { ReactElement } from "react"

import {
  formatToolCallResultLabel,
  formatToolCallStatus,
  formatToolCallTarget,
  isAnsweredToolCall,
  parseToolCallArguments
} from "./reply-presentation"

/** Properties accepted by {@link ToolCallStep}. */
export type ToolCallStepProps = {
  /** The stored call. */
  readonly call: ToolCallReplyPart
}

/**
 * Presents one tool call of a reply as a disclosure that starts collapsed.
 *
 * @remarks Presentational. The summary names the tool, what the call is
 * about, and its state; opening it shows the call's arguments, as named
 * values when the model wrote a JSON object and as written otherwise, and,
 * for a `succeeded`, `failed`, or `rejected` call, the plain text of its
 * result: the output it gave, why it failed, or the person's rejection. The
 * native disclosure owns whether it is open.
 * @param props - The stored call.
 * @returns The call disclosure.
 */
export default function ToolCallStep({
  call
}: ToolCallStepProps): ReactElement {
  const target = formatToolCallTarget(call)
  const callArguments = parseToolCallArguments(call.argumentText)

  return (
    <details className="chat-view__call" data-status={call.status}>
      <summary className="chat-view__call-summary">
        <span className="chat-view__call-name">{call.toolName}</span>
        {target !== "" && (
          <span className="chat-view__call-target">{target}</span>
        )}
        <span className="chat-view__call-status">
          {formatToolCallStatus(call.status)}
        </span>
      </summary>
      <div className="chat-view__call-detail">
        <p className="chat-view__call-label">Arguments</p>
        {callArguments === undefined ? (
          <pre className="chat-view__call-text">{call.argumentText}</pre>
        ) : (
          <dl className="chat-view__call-arguments">
            {callArguments.map(([name, value]) => (
              <div key={name}>
                <dt>{name}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {isAnsweredToolCall(call) && (
          <>
            <p className="chat-view__call-label">
              {formatToolCallResultLabel(call)}
            </p>
            <pre className="chat-view__call-text">{call.result}</pre>
          </>
        )}
      </div>
    </details>
  )
}
