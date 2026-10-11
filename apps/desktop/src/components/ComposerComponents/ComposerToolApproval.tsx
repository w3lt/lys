import type { ChatToolCall } from "@lys/protocol"
import type { ToolAccess, ToolRunner } from "@lys/share"
import { useId, useState, type ReactElement } from "react"
import { ChevronRight, Lock } from "lucide-react"

import {
  formatToolAccessLabel,
  getToolRunnerPresentation
} from "@/components/SettingsViewComponents/tool-presentation"
import { Button } from "@/components/ui/button"
import type { HeldToolCallAnswer, ShownToolCall } from "@/lib/store/tool-calls"

import {
  DRAFT_APPROVAL_HINT,
  EMPTY_DRAFT_APPROVAL_HINT,
  formatToolCallSummary
} from "./tool-approval-presentation"

/** Properties accepted by {@link ComposerToolApproval}. */
type ComposerToolApprovalProps = {
  /** Call shown: one that waits for the person, or whose answer failed to send. */
  readonly toolCall: ShownToolCall
  /** Whether the composer holds text, which Enter then sends as a rejection. */
  readonly hasDraft: boolean
  /** Requests that the parent allow the waiting call once. */
  readonly onAllowToolCall: () => void
  /** Requests that the parent reject the waiting call, with the draft as reason. */
  readonly onRejectToolCall: () => void
  /** Requests that the parent send the failed answer again. */
  readonly onRetryToolResult: () => void
}

/** Properties accepted by {@link ComposerToolCallRequest}. */
type ComposerToolCallRequestProps = {
  /** Call that waits for the person, as the backend sent it. */
  readonly call: ChatToolCall
  /** Definition and validated input of the waiting call. */
  readonly answer: Extract<HeldToolCallAnswer, { status: "awaiting-person" }>
  /** Whether the composer holds text, which Enter then sends as a rejection. */
  readonly hasDraft: boolean
  /** Requests that the parent allow the call once. */
  readonly onAllowToolCall: () => void
  /** Requests that the parent reject the call, with the draft as reason. */
  readonly onRejectToolCall: () => void
}

/** Properties accepted by {@link ComposerCalledTool}. */
type ComposerCalledToolProps = {
  /** Name of the called tool, as the backend sent it. */
  readonly toolName: string
  /** What the tool does with the machine, from its definition. */
  readonly access: ToolAccess
  /** Side that runs the tool, from its definition. */
  readonly runner: ToolRunner
}

/** Properties accepted by {@link ComposerToolCallArguments}. */
type ComposerToolCallArgumentsProps = {
  /** Identifier the arguments toggle points at through `aria-controls`. */
  readonly listId: string
  /** Arguments of the call, by name, as the backend sent them. */
  readonly callArguments: ChatToolCall["arguments"]
}

/** Properties accepted by {@link ComposerToolCallFooter}. */
type ComposerToolCallFooterProps = {
  /** Whether the composer holds text, which turns Allow once into Allow anyway. */
  readonly hasDraft: boolean
  /** Requests that the parent allow the call once. */
  readonly onAllowToolCall: () => void
  /** Requests that the parent reject the call, with the draft as reason. */
  readonly onRejectToolCall: () => void
}

/** Properties accepted by {@link ComposerToolResultFailure}. */
type ComposerToolResultFailureProps = {
  /** Name of the tool whose answer failed to send. */
  readonly toolName: string
  /** User-presentable reason the answer was not sent. */
  readonly error: string
  /** Requests that the parent send the failed answer again. */
  readonly onRetryToolResult: () => void
}

/**
 * Presents the called tool: its name, what it does with the machine, and
 * where it runs.
 *
 * @remarks The lock icon is decorative. The component owns no state.
 * @param props - Tool name, access level, and runner.
 * @returns The tool line of a waiting call's card.
 */
function ComposerCalledTool({
  toolName,
  access,
  runner
}: ComposerCalledToolProps): ReactElement {
  const runnerPresentation = getToolRunnerPresentation(runner)

  return (
    <div className="composer__approval-tool">
      <Lock aria-hidden="true" />
      <span className="composer__approval-tool-name">{toolName}</span>
      <span className="composer__approval-badge" data-badge="access">
        {formatToolAccessLabel(access)}
      </span>
      <span
        className="composer__approval-badge"
        data-badge="origin"
        title={runnerPresentation.title}
      >
        {runnerPresentation.label}
      </span>
    </div>
  )
}

/**
 * Presents a waiting call's arguments as a name and value list.
 *
 * @remarks Values are shown as text in the order the call lists them. The
 * component owns no state.
 * @param props - List identifier and the call's arguments.
 * @returns The argument list.
 */
function ComposerToolCallArguments({
  listId,
  callArguments
}: ComposerToolCallArgumentsProps): ReactElement {
  return (
    <dl className="composer__approval-arguments" id={listId}>
      {Object.entries(callArguments).map(([argumentName, argumentValue]) => (
        <div key={argumentName}>
          <dt>{argumentName}</dt>
          <dd>{String(argumentValue)}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * Presents the answers to a waiting call: a hint, Reject, and Allow.
 *
 * @remarks Without a draft, Allow once is the primary action and announces
 * Enter as its shortcut; with one, Allow anyway allows the call and keeps
 * the draft, and the hint says Enter sends the draft as a rejection. Reject
 * announces Escape. The parent routes both keys from the composer field. The
 * component owns no state.
 * @param props - Whether a draft exists, and the answers.
 * @returns The footer of a waiting call's card.
 */
function ComposerToolCallFooter({
  hasDraft,
  onAllowToolCall,
  onRejectToolCall
}: ComposerToolCallFooterProps): ReactElement {
  return (
    <div className="composer__approval-footer">
      <span className="composer__approval-hint">
        {hasDraft ? DRAFT_APPROVAL_HINT : EMPTY_DRAFT_APPROVAL_HINT}
      </span>
      <Button
        aria-keyshortcuts="Escape"
        onClick={onRejectToolCall}
        size="sm"
        type="button"
        variant="outline"
      >
        Reject <kbd aria-hidden="true">esc</kbd>
      </Button>
      {hasDraft ? (
        <Button
          onClick={onAllowToolCall}
          size="sm"
          type="button"
          variant="outline"
        >
          Allow anyway
        </Button>
      ) : (
        <Button
          aria-keyshortcuts="Enter"
          onClick={onAllowToolCall}
          size="sm"
          type="button"
        >
          Allow once <kbd aria-hidden="true">↵</kbd>
        </Button>
      )}
    </div>
  )
}

/**
 * Presents one call that waits for the person: what it will do, its
 * arguments on request, and the Reject and Allow buttons.
 *
 * @remarks The component owns only whether the arguments are shown, which
 * starts hidden; the parent keys it by call, so each call starts hidden. The
 * parent owns the call, the draft, and every answer, including Esc and Enter
 * in the composer field. Reject uses the draft as the reason. The card is a
 * named group, and the arguments toggle exposes its state through
 * `aria-expanded`.
 * @param props - Waiting call, whether a draft exists, and the answers.
 * @returns The waiting call's card.
 */
function ComposerToolCallRequest({
  call,
  answer,
  hasDraft,
  onAllowToolCall,
  onRejectToolCall
}: ComposerToolCallRequestProps): ReactElement {
  const [isArgumentsExpanded, setIsArgumentsExpanded] = useState(false)
  const argumentsId = useId()
  const hasArguments = Object.keys(call.arguments).length > 0

  return (
    <fieldset
      aria-label="Tool call waiting for your answer"
      className="composer__approval"
    >
      <div className="composer__approval-header">
        <span aria-hidden="true" className="composer__approval-dot" />
        <span className="composer__approval-label">She’s paused for you</span>
        {hasArguments ? (
          <button
            aria-controls={isArgumentsExpanded ? argumentsId : undefined}
            aria-expanded={isArgumentsExpanded}
            className="composer__approval-toggle"
            onClick={() => setIsArgumentsExpanded((isExpanded) => !isExpanded)}
            type="button"
          >
            <ChevronRight aria-hidden="true" />
            Arguments
          </button>
        ) : null}
      </div>

      <ComposerCalledTool
        access={answer.definition.access}
        runner={answer.definition.runner}
        toolName={call.toolName}
      />

      <p className="composer__approval-summary">
        {formatToolCallSummary(answer.input)}
      </p>

      {isArgumentsExpanded ? (
        <ComposerToolCallArguments
          callArguments={call.arguments}
          listId={argumentsId}
        />
      ) : null}

      <ComposerToolCallFooter
        hasDraft={hasDraft}
        onAllowToolCall={onAllowToolCall}
        onRejectToolCall={onRejectToolCall}
      />
    </fieldset>
  )
}

/**
 * Presents one call whose answer failed to send, with the reason and Try
 * again.
 *
 * @remarks The card is a named group. The reason is announced as an alert
 * because the reply waits until the answer is sent. Try again sends the same
 * answer without running the tool again; the parent owns the retry and its
 * outcome. The component owns no state.
 * @param props - Tool, reason, and the retry action.
 * @returns The failed answer's card.
 */
function ComposerToolResultFailure({
  toolName,
  error,
  onRetryToolResult
}: ComposerToolResultFailureProps): ReactElement {
  return (
    <fieldset
      aria-label="Tool answer not sent"
      className="composer__approval"
      data-failed=""
    >
      <div className="composer__approval-header">
        <span aria-hidden="true" className="composer__approval-dot" />
        <span className="composer__approval-label">Answer not sent</span>
      </div>

      <div className="composer__approval-tool">
        <span className="composer__approval-tool-name">{toolName}</span>
      </div>

      <p className="composer__approval-summary" role="alert">
        {error}
      </p>

      <div className="composer__approval-footer">
        <Button onClick={onRetryToolResult} size="sm" type="button">
          Try again
        </Button>
      </div>
    </fieldset>
  )
}

/**
 * Presents the tool call shown above the composer field: a call that waits
 * for the person, or one whose answer failed to send.
 *
 * @remarks The parent selects the call, owns every answer, and routes Esc
 * and Enter from the composer field; it keys this component by call, so a
 * new call starts with its arguments hidden. A waiting call shows what it
 * will do and offers Reject and Allow once, or Allow anyway while the
 * composer holds text. A failed answer shows the reason and Try again.
 * @param props - Shown call, whether a draft exists, and the answers.
 * @returns The card for the call's state.
 */
export default function ComposerToolApproval({
  toolCall,
  hasDraft,
  onAllowToolCall,
  onRejectToolCall,
  onRetryToolResult
}: ComposerToolApprovalProps): ReactElement {
  const { answer } = toolCall

  switch (answer.status) {
    case "awaiting-person":
      return (
        <ComposerToolCallRequest
          answer={answer}
          call={toolCall.call}
          hasDraft={hasDraft}
          onAllowToolCall={onAllowToolCall}
          onRejectToolCall={onRejectToolCall}
        />
      )
    case "send-failed":
      return (
        <ComposerToolResultFailure
          error={answer.error}
          onRetryToolResult={onRetryToolResult}
          toolName={toolCall.call.toolName}
        />
      )
  }
}
