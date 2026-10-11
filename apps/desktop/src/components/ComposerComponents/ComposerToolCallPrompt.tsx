import type { ReactElement } from "react"

import { useChatViewStore } from "@/lib/store/chat-view"
import { findShownToolCall, useToolCallStore } from "@/lib/store/tool-calls"

import ComposerToolApproval from "./ComposerToolApproval"
import { formatToolCallAnnouncement } from "./tool-approval-presentation"

/** Properties accepted by {@link ComposerToolCallPrompt}. */
type ComposerToolCallPromptProps = {
  /** Name of the agent answering the shown conversation. */
  readonly agentName: string
  /**
   * Requests that the parent reject the waiting call with the draft as the
   * reason, and clear the draft.
   */
  readonly onRejectToolCall: (callId: string) => void
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
 * belongs to the parent, because it also clears the draft. The polite status
 * line is always rendered, so it exists before a call starts waiting; it is
 * empty while no call waits. The card is keyed by call, so each call starts
 * with its arguments hidden. The announcement names the agent the parent
 * supplies.
 * @param props - Answering agent's name and the parent-owned rejection.
 * @returns The status line and, while a call needs the person, its card.
 */
export default function ComposerToolCallPrompt({
  agentName,
  onRejectToolCall
}: ComposerToolCallPromptProps): ReactElement {
  const conversationId = useChatViewStore((state) => state.conversation?.id)
  const hasDraft = useChatViewStore(
    (state) => state.inputDraft.trim().length > 0
  )
  const shownToolCall = useToolCallStore((state) =>
    findShownToolCall(state, conversationId)
  )
  const resolveToolCall = useToolCallStore((state) => state.resolveToolCall)
  const sendUnsentToolResult = useToolCallStore(
    (state) => state.sendUnsentToolResult
  )

  return (
    <>
      <output className="sr-only">
        {formatToolCallAnnouncement(shownToolCall, agentName)}
      </output>

      {shownToolCall === undefined ? null : (
        <ComposerToolApproval
          hasDraft={hasDraft}
          key={shownToolCall.call.id}
          onAllowToolCall={() => void resolveToolCall(shownToolCall.call.id)}
          onRejectToolCall={() => onRejectToolCall(shownToolCall.call.id)}
          onRetryToolResult={() =>
            void sendUnsentToolResult(shownToolCall.call.id)
          }
          toolCall={shownToolCall}
        />
      )}
    </>
  )
}
