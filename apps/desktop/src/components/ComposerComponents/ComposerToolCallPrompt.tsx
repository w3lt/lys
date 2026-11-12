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
  /**
   * Requests that the parent stop showing the expired prompt and move focus
   * on, because Dismiss leaves with the card.
   */
  readonly onDismissToolCall: (callId: string) => void
}

/**
 * Presents the tool call of the shown conversation that needs the person,
 * or whose prompt expired, and announces each call that starts waiting and
 * each prompt that expires.
 *
 * @remarks The chat-view store supplies the shown conversation and whether
 * the draft holds text; the tool-call store supplies the first call of that
 * conversation that waits for the person or whose answer failed to send,
 * else the first whose prompt expired, and owns its answers. Allow once and
 * Allow anyway resolve the call, and Try again sends the unsent answer
 * without running the tool again. Reject belongs to the parent, because it
 * also clears the draft, and so does Dismiss, which stops showing an expired
 * prompt, because the parent moves focus to its field. The polite
 * status line is always rendered, so it exists before a call starts waiting;
 * it is empty while no call waits and no prompt expired. The card is keyed
 * by call, so each call starts with its arguments hidden. The announcement
 * names the agent the parent supplies.
 * @param props - Answering agent's name and the parent-owned rejection and
 * dismissal.
 * @returns The status line and, while a call needs the person or a prompt
 * expired, its card.
 */
export default function ComposerToolCallPrompt({
  agentName,
  onRejectToolCall,
  onDismissToolCall
}: ComposerToolCallPromptProps): ReactElement {
  const conversationId = useChatViewStore((state) => state.conversation?.id)
  const hasDraft = useChatViewStore(
    (state) => state.inputDraft.trim().length > 0
  )
  const shownToolCall = useToolCallStore((state) =>
    findShownToolCall(state, conversationId)
  )
  const resolveToolCall = useToolCallStore((state) => state.resolveToolCall)
  const sendUnsentToolCallAnswer = useToolCallStore(
    (state) => state.sendUnsentToolCallAnswer
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
          onDismissToolCall={() => onDismissToolCall(shownToolCall.call.id)}
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
