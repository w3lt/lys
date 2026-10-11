import { useAgentStore } from "../store/agents"
import {
  findAnsweringAgent,
  type ConversationAgent
} from "../store/agents/conversation-agent"
import { useChatViewStore } from "../store/chat-view"

/**
 * Reads the agent that answers the next message in the chat view.
 *
 * @returns What the agent list tells about the shown conversation's agent, or
 * before a conversation starts about the agent a new one is started with; the
 * value is recalculated whenever the list, the shown conversation, or the
 * selected agent changes.
 * @remarks The agent store owns the list and the chat-view store the shown
 * conversation and the selection; the hook only reads them and starts no
 * read of its own.
 */
export function useAnsweringAgent(): ConversationAgent {
  const list = useAgentStore((state) => state.list)
  const conversationAgentCode = useChatViewStore(
    (state) => state.conversation?.agentCode
  )
  const selectedAgentCode = useChatViewStore((state) => state.selectedAgentCode)

  return findAnsweringAgent(list, { conversationAgentCode, selectedAgentCode })
}
