import type { AgentSummary, BuiltInAgentSummary } from "@lys/protocol"
import { ChevronRight, Plus } from "lucide-react"
import { useId, useLayoutEffect, useRef, type ReactElement } from "react"

import { Button } from "@/components/ui/button"

import { formatCustomAgentCount } from "./agent-presentation"

/** Control of the agent list that receives focus when the list appears. */
export type AgentListFocusTarget =
  | {
      /** Focus stays where it is. */
      readonly kind: "none"
    }
  | {
      /** The New agent button receives focus. */
      readonly kind: "new-agent"
    }
  | {
      /** One listed agent's row receives focus. */
      readonly kind: "agent"
      /** Code of that agent. */
      readonly agentCode: string
    }

/**
 * Handles the attachment of an element that takes focus when it appears, by
 * focusing it.
 *
 * @param element - Attached element, or null when React detaches it, which
 * is ignored.
 */
function handleFocusTargetAttach(element: HTMLElement | null): void {
  element?.focus()
}

/**
 * Reports whether keyboard focus has fallen back to the document.
 *
 * @returns Whether no element other than the body holds focus, as after the
 * focused element was removed.
 */
function isDocumentFocusLost(): boolean {
  const { activeElement } = document

  return activeElement === null || activeElement === document.body
}

/** Properties accepted by {@link AgentListItem}. */
type AgentListItemProps = {
  /** Listed built-in or stored agent shown by the row. */
  readonly agent: BuiltInAgentSummary | AgentSummary
  /** Whether the agent was the one saved most recently. */
  readonly isRecentlySaved: boolean
  /** Whether the row takes focus when it is attached. */
  readonly isFocusedOnAttach: boolean
  /** Requests that the parent open the agent's editor, once per activation. */
  readonly onOpenAgent: (agentCode: string) => void
}

/**
 * Presents one listed agent as a button that opens it.
 *
 * @remarks The list owner supplies the key
 * and decides which row takes focus; the row owns no state or effects. The
 * button is named by the agent's name and code, which tells apart agents
 * sharing a name, and described by its bio and, when the agent was saved most
 * recently, `saved`; the chevron is decorative.
 * @param props - Listed agent, its markers, and the parent-owned open action.
 * @returns One list item holding the row button.
 */
function AgentListItem({
  agent,
  isRecentlySaved,
  isFocusedOnAttach,
  onOpenAgent
}: AgentListItemProps): ReactElement {
  const nameId = useId()
  const codeId = useId()
  const bioId = useId()
  const savedId = useId()

  return (
    <li className="settings-view__agent-row">
      <button
        aria-describedby={isRecentlySaved ? `${bioId} ${savedId}` : bioId}
        aria-labelledby={`${nameId} ${codeId}`}
        className="settings-view__agent-choice"
        onClick={() => onOpenAgent(agent.code)}
        ref={isFocusedOnAttach ? handleFocusTargetAttach : undefined}
        type="button"
      >
        <span className="settings-view__agent-lines">
          <span className="settings-view__agent-title">
            <span className="settings-view__agent-name" id={nameId}>
              {agent.name}
            </span>
            <span className="settings-view__agent-code" id={codeId}>
              {agent.code}
            </span>
          </span>
          <span className="settings-view__agent-bio" id={bioId}>
            {agent.bio}
          </span>
        </span>
        {isRecentlySaved ? (
          <span className="settings-view__agent-saved" id={savedId}>
            saved
          </span>
        ) : null}
        <ChevronRight
          aria-hidden="true"
          className="settings-view__agent-chevron"
        />
      </button>
    </li>
  )
}

/** Properties accepted by {@link BuiltInAgentSection}. */
export type BuiltInAgentSectionProps = {
  /** Every built-in agent, in the order the backend ships them. */
  readonly agents: readonly BuiltInAgentSummary[]
  /** Control that takes focus when the section is attached. */
  readonly focusTarget: AgentListFocusTarget
  /** Requests that the parent open one agent's read-only view. */
  readonly onOpenAgent: (agentCode: string) => void
}

/**
 * Presents the agents that ship with Lys, which can be read and duplicated
 * but not changed or deleted.
 *
 * @remarks The parent owns the agents, the focus target, and the open
 * action; the section owns no state or effects. Agents keep the given order
 * and are keyed by code. A built-in agent is never saved, so no row is marked
 * as saved. The section is named by its heading, and the list is named
 * Built-in agents.
 * @param props - Agents, focus target, and the parent-owned open action.
 * @returns The section of the built-in agents.
 */
export function BuiltInAgentSection({
  agents,
  focusTarget,
  onOpenAgent
}: BuiltInAgentSectionProps): ReactElement {
  const headingId = useId()
  const focusedAgentCode =
    focusTarget.kind === "agent" ? focusTarget.agentCode : null

  return (
    <section aria-labelledby={headingId} className="settings-view__section">
      <div className="settings-view__section-heading">
        <h2 id={headingId}>built-in</h2>
        <span>ship with Lys · not editable</span>
      </div>
      <ul aria-label="Built-in agents" className="settings-view__agent-list">
        {agents.map((agent) => (
          <AgentListItem
            agent={agent}
            isFocusedOnAttach={agent.code === focusedAgentCode}
            isRecentlySaved={false}
            key={agent.code}
            onOpenAgent={onOpenAgent}
          />
        ))}
      </ul>
    </section>
  )
}

/** Properties accepted by {@link CustomAgentSection}. */
export type CustomAgentSectionProps = {
  /** Every stored agent, oldest first, each code once. */
  readonly agents: readonly AgentSummary[]
  /** Code of the agent saved most recently, or null when none is marked. */
  readonly savedAgentCode: string | null
  /** Control that takes focus when the section is attached. */
  readonly focusTarget: AgentListFocusTarget
  /** Requests that the parent open one agent's editor. */
  readonly onOpenAgent: (agentCode: string) => void
  /** Requests that the parent open an editor for a new agent. */
  readonly onOpenNewAgent: () => void
}

/**
 * Presents the user's agents and the action that starts a new one.
 *
 * @remarks The parent owns the agents, the
 * saved marker, the focus target, and both actions; the section owns no state
 * or effects. Agents keep the given order and are keyed by code. Without
 * agents the section says so instead of showing a list. The section is named
 * by its heading, and the list is named Your agents.
 * @param props - Agents, markers, focus target, and the parent-owned actions.
 * @returns The section of the user's agents.
 */
export function CustomAgentSection({
  agents,
  savedAgentCode,
  focusTarget,
  onOpenAgent,
  onOpenNewAgent
}: CustomAgentSectionProps): ReactElement {
  const headingId = useId()
  const focusedAgentCode =
    focusTarget.kind === "agent" ? focusTarget.agentCode : null

  /**
   * Builds the row of one listed agent.
   *
   * @param agent - Listed agent.
   * @returns The agent's list item, keyed by its code, focused on attach when
   * it is the focus target and marked when it was saved most recently.
   */
  function buildAgentListItem(agent: AgentSummary): ReactElement {
    return (
      <AgentListItem
        agent={agent}
        isFocusedOnAttach={agent.code === focusedAgentCode}
        isRecentlySaved={agent.code === savedAgentCode}
        key={agent.code}
        onOpenAgent={onOpenAgent}
      />
    )
  }

  return (
    <section aria-labelledby={headingId} className="settings-view__section">
      <div className="settings-view__section-heading">
        <h2 id={headingId}>yours</h2>
        <div className="settings-view__agent-tools">
          <span>{formatCustomAgentCount(agents.length)}</span>
          <Button
            onClick={onOpenNewAgent}
            ref={
              focusTarget.kind === "new-agent"
                ? handleFocusTargetAttach
                : undefined
            }
            size="sm"
            type="button"
            variant="outline"
          >
            <Plus aria-hidden="true" />
            New agent
          </Button>
        </div>
      </div>
      {agents.length === 0 ? (
        <p className="settings-view__note">
          None of your own yet. Start blank, or duplicate a built-in and change
          what you need.
        </p>
      ) : (
        <ul aria-label="Your agents" className="settings-view__agent-list">
          {agents.map(buildAgentListItem)}
        </ul>
      )}
    </section>
  )
}

/** Properties accepted by {@link AgentListStatus}. */
export type AgentListStatusProps = {
  /**
   * Sentence explaining why the agents are not shown, or an empty string
   * while they can be shown.
   */
  readonly message: string
  /**
   * Requests that the parent read the agents again; omitted when reading
   * again cannot help, which removes the Retry button.
   */
  readonly onRetryAgents?: () => void
}

/**
 * Explains why the agents are not shown, offering a retry when one can help.
 *
 * @remarks The parent owns the message and the retry, and keeps the
 * component mounted while the pane is shown, so the message is one polite
 * status that exists before every change it announces; it is empty and takes
 * no space while the agents can be shown. A message never takes focus from a
 * control that still holds it. When a message appears after the focused
 * control was removed, as when the backend stops or a refresh fails under the
 * list or an editor, focus moves to Retry when offered, otherwise to the
 * message. Pressing Retry moves focus to the message first, because Retry
 * leaves while the agents are read.
 * @param props - Message and the optional parent-owned retry.
 * @returns The status line and any Retry button.
 */
export function AgentListStatus({
  message,
  onRetryAgents
}: AgentListStatusProps): ReactElement {
  const messageRef = useRef<HTMLParagraphElement>(null)
  const retryButtonRef = useRef<HTMLButtonElement>(null)

  useLayoutEffect(() => {
    if (message === "" || !isDocumentFocusLost()) return

    const focusSuccessor = retryButtonRef.current ?? messageRef.current
    focusSuccessor?.focus()
  }, [message])

  /** Reads the agents again, keeping focus in the status while Retry leaves. */
  function handleRetryAgents(): void {
    messageRef.current?.focus()
    onRetryAgents?.()
  }

  return (
    <div className="settings-view__agent-status">
      <p
        aria-live="polite"
        className={message === "" ? undefined : "settings-view__note"}
        ref={messageRef}
        role="status"
        tabIndex={-1}
      >
        {message}
      </p>
      {onRetryAgents === undefined ? null : (
        <Button
          onClick={handleRetryAgents}
          ref={retryButtonRef}
          size="sm"
          type="button"
          variant="outline"
        >
          Retry
        </Button>
      )}
    </div>
  )
}
