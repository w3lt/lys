import { ChevronDown, Lock } from "lucide-react"
import type { ReactElement } from "react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import {
  calculateAgentInitial,
  formatConversationAgentName,
  type AgentChoice,
  type ConversationAgent
} from "@/lib/store/agents/conversation-agent"

import {
  formatAgentChoiceTag,
  formatAgentMenuTitle,
  formatFixedAgentBio,
  formatFixedAgentNote
} from "./agent-menu-presentation"

/** Properties accepted by {@link AgentChoiceList}. */
type AgentChoiceListProps = {
  /** Agents offered, built-in first, each code once. */
  readonly choices: readonly AgentChoice[]
  /** Code of the agent a new conversation starts with. */
  readonly selectedAgentCode: string
  /** Invoked with the code of the agent the user chose. */
  readonly onSelectAgent: (agentCode: string) => void
  /** Requests that the parent open the Agents settings pane. */
  readonly onOpenAgentSettings: () => void
}

/**
 * Lists the agents a new conversation can be started with.
 *
 * @remarks The parent owns the choices, the selection, and both callbacks;
 * the list owns no state. Each row states its condition as text: `selected`,
 * or `built-in` for an agent that ships with Lys. The adapter's radio check
 * mark is suppressed, as in the weights menu, because the row's tag already
 * carries the selection. Choosing a row closes the menu. Without choices the list says that no agent was
 * read. Rendered inside the agent menu's content.
 * @param props - Choices, selection, and the parent-owned callbacks.
 * @returns The rows of the agent menu before a conversation starts.
 */
function AgentChoiceList({
  choices,
  selectedAgentCode,
  onSelectAgent,
  onOpenAgentSettings
}: AgentChoiceListProps): ReactElement {
  return (
    <>
      <DropdownMenuRadioGroup
        onValueChange={onSelectAgent}
        value={selectedAgentCode}
      >
        <DropdownMenuLabel className="composer__menu-heading">
          <span className="composer__menu-eyebrow">agent</span>
          <span className="composer__menu-tag">fixed once you send</span>
        </DropdownMenuLabel>
        {choices.length === 0 ? (
          <DropdownMenuLabel>No agents read · open Agents</DropdownMenuLabel>
        ) : null}
        {choices.map((agent) => (
          <DropdownMenuRadioItem
            className="composer__model-option composer__agent-option"
            closeOnClick
            key={agent.code}
            value={agent.code}
          >
            <span aria-hidden="true" className="composer__agent-initial">
              {calculateAgentInitial(agent.name)}
            </span>
            <span className="composer__model-option-lines">
              <span className="composer__model-option-name">{agent.name}</span>
              <span className="composer__agent-bio">{agent.bio}</span>
            </span>
            <span className="composer__model-option-tag">
              {formatAgentChoiceTag(agent, selectedAgentCode)}
            </span>
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        className="composer__agent-action"
        onClick={onOpenAgentSettings}
      >
        <span>Edit agents</span>
        <span className="composer__menu-tag">settings →</span>
      </DropdownMenuItem>
    </>
  )
}

/** Properties accepted by {@link FixedAgentPanel}. */
type FixedAgentPanelProps = {
  /** What the agent list tells about the shown conversation's agent. */
  readonly agent: ConversationAgent
  /** Requests that the parent start a new conversation. */
  readonly onStartConversation: () => void
}

/**
 * Explains that a started conversation keeps its agent, and offers a new
 * conversation.
 *
 * @remarks The parent owns the agent and the callback; the panel owns no
 * state. A deleted agent is named by its code and described as deleted.
 * Start a new one keeps the menu open, so the agent of the new conversation
 * can be chosen at once. Rendered inside the agent menu's content.
 * @param props - Conversation's agent and the parent-owned callback.
 * @returns The agent menu's content once a conversation has started.
 */
function FixedAgentPanel({
  agent,
  onStartConversation
}: FixedAgentPanelProps): ReactElement {
  const agentName = formatConversationAgentName(agent)

  return (
    <>
      <DropdownMenuGroup>
        <DropdownMenuLabel className="composer__menu-heading">
          <span className="composer__menu-eyebrow">agent</span>
          <span className="composer__menu-tag">
            fixed for this conversation
          </span>
        </DropdownMenuLabel>
        <div className="composer__agent-fixed">
          <span aria-hidden="true" className="composer__agent-initial">
            {calculateAgentInitial(agentName)}
          </span>
          <span className="composer__model-option-lines">
            <span className="composer__model-option-name">{agentName}</span>
            <span className="composer__agent-bio">
              {formatFixedAgentBio(agent)}
            </span>
          </span>
        </div>
        <p className="composer__agent-note">{formatFixedAgentNote(agent)}</p>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        className="composer__agent-action"
        closeOnClick={false}
        onClick={onStartConversation}
      >
        Start a new one
      </DropdownMenuItem>
    </>
  )
}

/** Properties accepted by {@link ComposerAgentMenu}. */
export type ComposerAgentMenuProps = {
  /**
   * Agent that answers the next message: the shown conversation's, or the
   * one a new conversation starts with.
   */
  readonly agent: ConversationAgent
  /** Whether a conversation is shown, which fixes its agent. */
  readonly isConversationStarted: boolean
  /** Agents a new conversation can be started with, built-in first. */
  readonly choices: readonly AgentChoice[]
  /** Invoked with the code of the agent the user chose. */
  readonly onSelectAgent: (agentCode: string) => void
  /** Requests that the parent open the Agents settings pane. */
  readonly onOpenAgentSettings: () => void
  /** Requests that the parent start a new conversation. */
  readonly onStartConversation: () => void
}

/**
 * Names the agent answering this conversation and, before the first message,
 * switches between the agents.
 *
 * @remarks The parent owns the agent, the choices, and every callback; the
 * menu's open state belongs to the underlying menu adapter, as do keyboard
 * navigation, dismissal, and focus return. Before a conversation starts the
 * button shows a caret and the menu lists the choices. Once a conversation is
 * shown its agent is fixed: the button shows a lock, and the menu explains
 * why and offers a new conversation. The button is named by the agent and
 * its title says what pressing it is for. The initial beside each name is
 * decoration.
 * @param props - Answering agent, choices, and the parent-owned callbacks.
 * @returns The composer's agent menu.
 */
export default function ComposerAgentMenu({
  agent,
  isConversationStarted,
  choices,
  onSelectAgent,
  onOpenAgentSettings,
  onStartConversation
}: ComposerAgentMenuProps): ReactElement {
  const agentName = formatConversationAgentName(agent)
  const selectedAgentCode =
    agent.status === "listed" ? agent.agent.code : agent.code

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="composer__model composer__agent"
        title={formatAgentMenuTitle(agent, isConversationStarted)}
        type="button"
      >
        <span aria-hidden="true" className="composer__agent-initial">
          {calculateAgentInitial(agentName)}
        </span>
        <span className="composer__agent-name">{agentName}</span>
        {isConversationStarted ? (
          <Lock aria-hidden="true" className="composer__agent-lock" />
        ) : (
          <ChevronDown aria-hidden="true" className="composer__caret" />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="composer__menu composer__menu--agents"
        side="top"
      >
        {isConversationStarted ? (
          <FixedAgentPanel
            agent={agent}
            onStartConversation={onStartConversation}
          />
        ) : (
          <AgentChoiceList
            choices={choices}
            onOpenAgentSettings={onOpenAgentSettings}
            onSelectAgent={onSelectAgent}
            selectedAgentCode={selectedAgentCode}
          />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
