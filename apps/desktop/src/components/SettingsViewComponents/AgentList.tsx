import type { AgentSummary } from "@lys/protocol"
import { ChevronRight, Plus } from "lucide-react"
import { useId, type ReactElement } from "react"

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
 * Focuses an element as React attaches it.
 *
 * @param element - Attached element, or null when React detaches it.
 */
function focusElementOnAttach(element: HTMLElement | null): void {
  element?.focus()
}

/**
 * Presents the section for agents that ship with Lys, marked as coming soon.
 *
 * @remarks Primary category: presentational. Built-in agents do not exist
 * yet, so the section holds only its heading and a note; it owns no state,
 * effects, or callbacks. The section is named by its heading.
 * @returns The built-in agents section.
 */
export function BuiltInAgentSection(): ReactElement {
  const headingId = useId()

  return (
    <section aria-labelledby={headingId} className="settings-view__section">
      <div className="settings-view__section-heading">
        <h2 id={headingId}>built-in</h2>
        <span>coming soon</span>
      </div>
      <p className="settings-view__note">
        Agents that ship with Lys are not available yet. They will come in a
        later version.
      </p>
    </section>
  )
}

/** Properties accepted by {@link AgentListItem}. */
export type AgentListItemProps = {
  /** Listed agent shown by the row. */
  readonly agent: AgentSummary
  /** Whether the agent was the one saved most recently. */
  readonly isRecentlySaved: boolean
  /** Whether the row takes focus when it is attached. */
  readonly isFocusedOnAttach: boolean
  /** Requests that the parent open the agent's editor, once per activation. */
  readonly onOpenAgent: (agentCode: string) => void
}

/**
 * Presents one stored agent as a button that opens its editor.
 *
 * @remarks Primary category: presentational. The list owner supplies the key
 * and decides which row takes focus; the row owns no state or effects. The
 * button is named by the agent's name and code, which tells apart agents
 * sharing a name, and described by its bio and, when the agent was saved most
 * recently, `saved`; the chevron is decorative.
 * @param props - Listed agent, its markers, and the parent-owned open action.
 * @returns One list item holding the row button.
 */
export function AgentListItem({
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
        ref={isFocusedOnAttach ? focusElementOnAttach : undefined}
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
 * @remarks Primary category: presentational. The parent owns the agents, the
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
                ? focusElementOnAttach
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
          None of your own yet. Start one with New agent.
        </p>
      ) : (
        <ul aria-label="Your agents" className="settings-view__agent-list">
          {agents.map((agent) => (
            <AgentListItem
              agent={agent}
              isFocusedOnAttach={
                focusTarget.kind === "agent" &&
                focusTarget.agentCode === agent.code
              }
              isRecentlySaved={agent.code === savedAgentCode}
              key={agent.code}
              onOpenAgent={onOpenAgent}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

/** Properties accepted by {@link AgentListStatus}. */
export type AgentListStatusProps = {
  /** Sentence explaining why the agents are not shown. */
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
 * @remarks Primary category: presentational. The parent owns the message and
 * the retry; the component owns no state or effects. The message is a polite
 * status so it is announced without taking focus.
 * @param props - Message and the optional parent-owned retry.
 * @returns The status line and any Retry button.
 */
export function AgentListStatus({
  message,
  onRetryAgents
}: AgentListStatusProps): ReactElement {
  return (
    <div className="settings-view__agent-status">
      <p aria-live="polite" className="settings-view__note" role="status">
        {message}
      </p>
      {onRetryAgents === undefined ? null : (
        <Button
          onClick={onRetryAgents}
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
