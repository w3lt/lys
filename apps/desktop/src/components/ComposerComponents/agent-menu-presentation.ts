import {
  formatConversationAgentName,
  type AgentChoice,
  type ConversationAgent
} from "@/lib/store/agents/conversation-agent"

/**
 * Formats the tag at the end of one row of the agent menu.
 *
 * @param agent - Agent the row offers.
 * @param selectedAgentCode - Code of the agent a new conversation starts
 * with.
 * @returns `selected` for the selected agent, `built-in` for any other agent
 * that ships with Lys, and an empty string for the user's other agents.
 */
export function formatAgentChoiceTag(
  agent: AgentChoice,
  selectedAgentCode: string
): string {
  if (agent.code === selectedAgentCode) return "selected"

  return agent.kind === "built-in" ? "built-in" : ""
}

/**
 * Formats the title of the composer's agent button.
 *
 * @param agent - Agent that answers the next message.
 * @param isConversationStarted - Whether a conversation is shown, which
 * fixes its agent.
 * @returns What pressing the button is for: choosing the agent of a new
 * conversation, or reading why a started conversation keeps its agent.
 */
export function formatAgentMenuTitle(
  agent: ConversationAgent,
  isConversationStarted: boolean
): string {
  return isConversationStarted
    ? `${formatConversationAgentName(agent)} is fixed for this conversation`
    : "Choose who answers"
}

/**
 * Formats the line under the name of a started conversation's agent.
 *
 * @param agent - What the agent list tells about the conversation's agent.
 * @returns The listed agent's bio; `Deleted since.` for a deleted agent; an
 * empty string while the list is unread, when nothing is known.
 */
export function formatFixedAgentBio(agent: ConversationAgent): string {
  switch (agent.status) {
    case "listed":
      return agent.agent.bio
    case "deleted":
      return "Deleted since."
    case "unread":
      return ""
  }
}

/**
 * Formats the explanation of why a started conversation keeps its agent.
 *
 * @param agent - What the agent list tells about the conversation's agent.
 * @returns For a deleted agent, that it can no longer answer; otherwise that
 * its prompt shaped every reply, so it stays for the whole conversation.
 */
export function formatFixedAgentNote(agent: ConversationAgent): string {
  return agent.status === "deleted"
    ? "It can no longer answer here. To keep talking, start a new conversation with another agent."
    : "Its prompt has shaped every reply here, so it stays for the whole conversation. To talk to a different agent, start a new one."
}
