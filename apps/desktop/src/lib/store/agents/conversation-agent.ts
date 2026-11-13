import { CALIGINIA_AGENT_CODE } from "@lys/share"

import type { AgentListState } from "./index"

/** One agent a conversation can be answered by, as the composer lists it. */
export type AgentChoice = {
  /** Code sent to start a conversation the agent answers. */
  readonly code: string
  /** Display name. */
  readonly name: string
  /** Short description of what the agent does. */
  readonly bio: string
  /** Whether the agent ships with Lys or is one of the user's own. */
  readonly kind: "built-in" | "custom"
}

/** What the agent list tells about the agent that answers a conversation. */
export type ConversationAgent =
  | {
      /** The agent is listed, so it can answer. */
      readonly status: "listed"
      /** The listed agent. */
      readonly agent: AgentChoice
    }
  | {
      /** The list was not read, so nothing is known beyond the code. */
      readonly status: "unread"
      /** Code stored with the conversation. */
      readonly code: string
    }
  | {
      /** The list was read and no agent has the code any more. */
      readonly status: "deleted"
      /** Code stored with the conversation. */
      readonly code: string
    }

/**
 * Builds the agents a conversation can be started with.
 *
 * @param list - Agent list as last read.
 * @returns The built-in agents, then the user's own, in listed order; nothing
 * while no list is displayed.
 */
export function buildAgentChoices(
  list: AgentListState
): readonly AgentChoice[] {
  if (list.status !== "loaded") return []

  return [
    ...list.builtInAgents.map(({ code, name, bio }): AgentChoice => ({
      code,
      name,
      bio,
      kind: "built-in"
    })),
    ...list.agents.map(({ code, name, bio }): AgentChoice => ({
      code,
      name,
      bio,
      kind: "custom"
    }))
  ]
}

/**
 * Calculates the code of the agent a new conversation is started with.
 *
 * @param selectedAgentCode - Code of the agent the user selected.
 * @param list - Agent list as last read.
 * @returns The selected code while that agent is listed or no list is
 * displayed, since nothing then says the agent is gone; otherwise
 * Caliginia's code, because the selected agent was deleted.
 */
export function calculateNewConversationAgentCode(
  selectedAgentCode: string,
  list: AgentListState
): string {
  if (list.status !== "loaded") return selectedAgentCode

  const isSelectedAgentListed = buildAgentChoices(list).some(
    (agent) => agent.code === selectedAgentCode
  )
  return isSelectedAgentListed ? selectedAgentCode : CALIGINIA_AGENT_CODE
}

/**
 * Finds what the agent list tells about a conversation's agent.
 *
 * @param list - Agent list as last read.
 * @param agentCode - Code stored with the conversation.
 * @returns The listed agent; `deleted` when a displayed list holds no agent
 * with the code; `unread` while no list is displayed, which never claims a
 * deletion.
 */
export function findConversationAgent(
  list: AgentListState,
  agentCode: string
): ConversationAgent {
  if (list.status !== "loaded") return { status: "unread", code: agentCode }

  const agent = buildAgentChoices(list).find(
    (listed) => listed.code === agentCode
  )
  return agent === undefined
    ? { status: "deleted", code: agentCode }
    : { status: "listed", agent }
}

/** Agent codes the chat view holds when it asks which agent answers. */
export type AnsweringAgentCodes = {
  /**
   * Code stored with the shown conversation, or undefined before a
   * conversation starts.
   */
  readonly conversationAgentCode: string | undefined
  /** Code of the agent the user selected for a new conversation. */
  readonly selectedAgentCode: string
}

/**
 * Finds the agent that answers the next message in the chat view.
 *
 * @param list - Agent list as last read.
 * @param codes - Shown conversation's agent code and the selected one.
 * @returns What the list tells about the shown conversation's agent, which
 * never falls back to another agent; before a conversation starts, about the
 * agent a new conversation is started with.
 */
export function findAnsweringAgent(
  list: AgentListState,
  codes: AnsweringAgentCodes
): ConversationAgent {
  return findConversationAgent(
    list,
    codes.conversationAgentCode ??
      calculateNewConversationAgentCode(codes.selectedAgentCode, list)
  )
}

/**
 * Formats the name under which a conversation's agent is shown.
 *
 * @param agent - What the agent list tells about the agent.
 * @returns The listed agent's name; otherwise its code, the only identity
 * left once the agent is deleted or while the list is unread.
 */
export function formatConversationAgentName(agent: ConversationAgent): string {
  return agent.status === "listed" ? agent.agent.name : agent.code
}

/**
 * Calculates the initial that stands for an agent beside its name.
 *
 * @param name - Agent name or code.
 * @returns The first character of the trimmed name in upper case, whole even
 * when it is a surrogate pair; `?` for a blank name.
 */
export function calculateAgentInitial(name: string): string {
  const [firstCharacter] = Array.from(name.trim())

  return firstCharacter === undefined ? "?" : firstCharacter.toUpperCase()
}
