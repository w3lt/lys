import { useAgentStore } from "../store/agents"
import {
  findConversationAgent,
  formatConversationAgentName
} from "../store/agents/conversation-agent"

/**
 * Names the agent that gave the shown job, which wrote the job's messages.
 *
 * @param delegatorAgentCode - Code of the shown conversation's delegator,
 * null in a main conversation; read reactively.
 * @returns The delegator's name from the agent list, its code once the agent
 * is deleted or while the list is unread, or undefined when the shown
 * conversation is not a job. The value is recalculated whenever the list or
 * the code changes.
 * @remarks The agent store owns the list; the hook only reads it and starts
 * no read of its own.
 */
export function useDelegatorName(
  delegatorAgentCode: string | null
): string | undefined {
  const agentList = useAgentStore((state) => state.list)
  if (delegatorAgentCode === null) return undefined

  const delegator = findConversationAgent(agentList, delegatorAgentCode)
  return formatConversationAgentName(delegator)
}
