import type { Job } from "@lys/share"
import type { ReactElement } from "react"

import { useAgentStore, type AgentListState } from "@/lib/store/agents"
import {
  findConversationAgent,
  formatConversationAgentName
} from "@/lib/store/agents/conversation-agent"
import { useChatViewStore } from "@/lib/store/chat-view"
import type { ChatViewConversation } from "@/lib/store/chat-view/conversation-transitions"
import {
  findShownToolCall,
  useToolCallStore,
  type ShownToolCall
} from "@/lib/store/tool-calls"

import ComposerToolApproval from "./ComposerToolApproval"
import {
  formatToolCallAnnouncement,
  formatToolCallJobLine,
  type ToolCallJob
} from "./tool-approval-presentation"

/** Properties accepted by {@link ComposerToolCallPrompt}. */
type ComposerToolCallPromptProps = {
  /** Name of the agent answering the shown conversation. */
  readonly agentName: string
  /**
   * Whether the composer field routes Escape and Enter to the answers; false
   * while the field is off, as in a job, where the card's buttons alone
   * answer.
   */
  readonly hasKeyShortcuts: boolean
  /**
   * Requests that the parent reject the waiting call; the parent decides
   * whether the draft is the reason and whether it is cleared.
   */
  readonly onRejectToolCall: (callId: string) => void
}

/** Whose shown call it is, as the prompt names it. */
type ToolCallOrigin = Readonly<{
  /** Name of the agent whose call waits, which the announcement names. */
  agentName: string
  /**
   * Line naming the job of the shown conversation the call comes from;
   * undefined for a call of the shown conversation itself, or while no call
   * is shown.
   */
  jobLine: string | undefined
}>

/**
 * Finds one job of the shown conversation.
 *
 * @param conversation - The shown conversation, if any.
 * @param jobId - The job conversation's identity, if any.
 * @returns The job a main conversation lists under that identity; undefined
 * for a job, which starts no jobs, while no conversation is shown, or while
 * the conversation does not list the identity.
 */
function findShownJob(
  conversation: ChatViewConversation | undefined,
  jobId: string | undefined
): Job | undefined {
  if (conversation?.kind !== "main") return undefined

  return conversation.jobs.find((job) => job.id === jobId)
}

/**
 * Builds what the prompt names of the job a shown call comes from.
 *
 * @param job - The job, or undefined while the shown conversation does not
 * list it.
 * @param agentList - Agent list as last read.
 * @returns The job's agent name and title; the agent is named from the list,
 * by its code once it is deleted or while the list is unread. Undefined
 * without a job.
 */
function buildToolCallJob(
  job: Job | undefined,
  agentList: AgentListState
): ToolCallJob | undefined {
  if (job === undefined) return undefined

  const agent = findConversationAgent(agentList, job.agentCode)
  return { agentName: formatConversationAgentName(agent), title: job.title }
}

/**
 * Names whose shown call it is: the shown conversation's agent, or the
 * agent and the job of one of its jobs.
 *
 * @param shownToolCall - The call shown, or undefined while none is.
 * @param conversationId - The shown conversation, if any.
 * @param conversationAgentName - Name of the agent answering the shown
 * conversation.
 * @returns The agent the announcement names and the card's job line, both
 * recalculated whenever the call, the shown conversation's jobs, or the
 * agent list changes.
 * @remarks A call whose conversation is not the shown one comes from a job
 * of it, which the tool-call store found through the activity stream. While
 * the shown conversation does not list the job yet, the line and the
 * announcement say only that a job of this conversation asks. The chat-view
 * and agent stores own what the hook reads; it starts no read of its own.
 */
function useToolCallOrigin(
  shownToolCall: ShownToolCall | undefined,
  conversationId: string | undefined,
  conversationAgentName: string
): ToolCallOrigin {
  const callConversationId = shownToolCall?.target.conversationId
  const job = useChatViewStore((state) =>
    findShownJob(state.conversation, callConversationId)
  )
  const agentList = useAgentStore((state) => state.list)
  if (
    callConversationId === undefined ||
    callConversationId === conversationId
  ) {
    return { agentName: conversationAgentName, jobLine: undefined }
  }

  const toolCallJob = buildToolCallJob(job, agentList)
  return {
    agentName: toolCallJob?.agentName ?? "A job of this conversation",
    jobLine: formatToolCallJobLine(toolCallJob)
  }
}

/**
 * Presents the tool call of the shown conversation that needs the person,
 * and announces each call that starts waiting.
 *
 * @remarks The chat-view store supplies the shown conversation and whether
 * the draft holds text; the tool-call store supplies the first call of that
 * conversation that waits for the person or whose answer failed to send, and
 * owns its answers. Allow once and Allow anyway resolve the call, and Try
 * again sends the unsent answer without running the tool again. Reject
 * belongs to the parent, which owns the draft it may send as the reason and
 * clear. While the field routes no keys, a draft changes nothing a key would
 * do, so the card offers Allow once whatever the draft holds and names no
 * keys. The polite status
 * line is always rendered, so it exists before a call starts waiting; it is
 * empty while no call waits. The card is keyed by call, so each call starts
 * with its arguments hidden. The announcement names the agent the parent
 * supplies for a call of the shown conversation itself. A call of one of its
 * jobs, which the tool-call store shows in the job's parent, is announced
 * under the job's agent, and its card names the agent and the job above
 * what the call will do.
 * @param props - Answering agent's name, whether the field routes the
 * answer keys, and the parent-owned rejection.
 * @returns The status line and, while a call needs the person, its card.
 */
export default function ComposerToolCallPrompt({
  agentName,
  hasKeyShortcuts,
  onRejectToolCall
}: ComposerToolCallPromptProps): ReactElement {
  const conversationId = useChatViewStore((state) => state.conversation?.id)
  const hasDraft = useChatViewStore(
    (state) => hasKeyShortcuts && state.inputDraft.trim().length > 0
  )
  const shownToolCall = useToolCallStore((state) =>
    findShownToolCall(state, conversationId)
  )
  const resolveToolCall = useToolCallStore((state) => state.resolveToolCall)
  const sendUnsentToolCallAnswer = useToolCallStore(
    (state) => state.sendUnsentToolCallAnswer
  )
  const origin = useToolCallOrigin(shownToolCall, conversationId, agentName)

  return (
    <>
      <output className="sr-only">
        {formatToolCallAnnouncement(shownToolCall, origin.agentName)}
      </output>

      {shownToolCall === undefined ? null : (
        <ComposerToolApproval
          hasDraft={hasDraft}
          hasKeyShortcuts={hasKeyShortcuts}
          jobLine={origin.jobLine}
          key={shownToolCall.call.id}
          onAllowToolCall={() => void resolveToolCall(shownToolCall.call.id)}
          onRejectToolCall={() => onRejectToolCall(shownToolCall.call.id)}
          onRetryToolCallAnswer={() =>
            void sendUnsentToolCallAnswer(shownToolCall.call.id)
          }
          toolCall={shownToolCall}
        />
      )}
    </>
  )
}
