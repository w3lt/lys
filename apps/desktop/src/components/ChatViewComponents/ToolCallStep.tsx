import { isAnsweredToolCall } from "@lys/share"
import type { ReactElement } from "react"

import type { ChatViewToolCallReplyPart } from "@/lib/store/chat-view/reply-parts"

import {
  formatReplyControlName,
  formatToolCallName,
  formatToolCallResultLabel,
  formatToolCallStatus
} from "./reply-presentation"

/** Properties accepted by {@link ToolCallStep}. */
export type ToolCallStepProps = {
  /** The stored call, with its arguments parsed by the store. */
  readonly call: ChatViewToolCallReplyPart
  /** One-based position of the call's reply among the transcript's replies. */
  readonly replyNumber: number
}

/** Properties accepted by {@link ToolCallText}. */
type ToolCallTextProps = {
  /** Visible label of the text, such as `Result`. */
  readonly label: string
  /** Text as written. */
  readonly text: string
  /** Name of the call and its reply, which tells this text apart. */
  readonly callName: string
}

/**
 * Presents one of a call's texts, which may be longer than its scroll area.
 *
 * @remarks The text scrolls within a bounded height, so it is a focusable
 * region named by its label and its call, such as `Result of web_search
 * night moths, reply 2`, which keyboard users reach with Tab and scroll
 * with the arrow keys.
 * @param props - The text, its label, and its call's name.
 * @returns The label and the scrollable text.
 */
function ToolCallText({
  label,
  text,
  callName
}: ToolCallTextProps): ReactElement {
  return (
    <>
      <p className="chat-view__call-label">{label}</p>
      <pre
        aria-label={`${label} of ${callName}`}
        className="chat-view__call-text"
        role="region"
        tabIndex={0}
      >
        {text}
      </pre>
    </>
  )
}

/** Properties accepted by {@link ToolCallArguments}. */
type ToolCallArgumentsProps = {
  /** The stored call, with its arguments parsed by the store. */
  readonly call: ChatViewToolCallReplyPart
  /** Name of the call and its reply, which tells its texts apart. */
  readonly callName: string
}

/**
 * Presents the arguments of a call.
 *
 * @param props - The call and its name.
 * @returns Each argument's name and value when the model wrote a JSON
 * object; the argument text as written, through {@link ToolCallText},
 * otherwise.
 */
function ToolCallArguments({
  call,
  callName
}: ToolCallArgumentsProps): ReactElement {
  const { entries } = call.argumentsView
  if (entries === undefined)
    return (
      <ToolCallText
        callName={callName}
        label="Arguments"
        text={call.argumentText}
      />
    )
  return (
    <>
      <p className="chat-view__call-label">Arguments</p>
      <dl className="chat-view__call-arguments">
        {entries.map(([name, value]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </>
  )
}

/**
 * Presents one tool call of a reply as a disclosure that starts collapsed.
 *
 * @remarks The summary names the tool, what the call is about, and its
 * state, and its accessible name adds the reply, so calls of different
 * replies stay apart; opening it shows the call's arguments, as named
 * values when the model wrote a JSON object and as written otherwise, and,
 * for a `succeeded`, `failed`, or `rejected` call, the plain text of its
 * result: the output it gave, why it failed, or the person's rejection.
 * The native disclosure owns whether it is open.
 * @param props - The stored call and its reply's position.
 * @returns The call disclosure.
 */
export default function ToolCallStep({
  call,
  replyNumber
}: ToolCallStepProps): ReactElement {
  const { target } = call.argumentsView
  const status = formatToolCallStatus(call.status)
  const name = formatToolCallName(call.toolName, target)
  const summaryName = name === "" ? status : `${name} ${status}`
  const callName = formatReplyControlName(name, replyNumber)

  return (
    <details className="chat-view__call" data-status={call.status}>
      <summary
        aria-label={formatReplyControlName(summaryName, replyNumber)}
        className="chat-view__call-summary"
      >
        <span className="chat-view__call-name">{call.toolName}</span>
        {target !== "" && (
          <span className="chat-view__call-target">{target}</span>
        )}
        <span className="chat-view__call-status">{status}</span>
      </summary>
      <div className="chat-view__call-detail">
        <ToolCallArguments call={call} callName={callName} />
        {isAnsweredToolCall(call) && (
          <ToolCallText
            callName={callName}
            label={formatToolCallResultLabel(call)}
            text={call.result}
          />
        )}
      </div>
    </details>
  )
}
