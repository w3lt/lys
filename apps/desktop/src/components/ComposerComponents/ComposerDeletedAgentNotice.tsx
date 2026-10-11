import type { ReactElement } from "react"

import { Button } from "@/components/ui/button"
import { DELETED_CONVERSATION_AGENT_MESSAGE } from "@/lib/conversation-agent-messages"

/** Properties accepted by {@link ComposerDeletedAgentNotice}. */
export type ComposerDeletedAgentNoticeProps = {
  /**
   * Whether the notice is shown: the shown conversation's agent was deleted
   * and no more urgent banner stands in its place.
   */
  readonly isShown: boolean
  /** Requests that the parent start a new conversation. */
  readonly onStartConversation: () => void
}

/**
 * States that the shown conversation's agent was deleted and offers a new
 * conversation.
 *
 * @remarks The parent decides when the notice is shown and owns the callback;
 * this component owns no state, effects, or resources. Its polite status line
 * is always rendered, so it exists before the sentence it announces; it is
 * empty, and the notice takes no room, while the notice is not shown. New
 * conversation sits beside the status line, outside it, and is rendered only
 * while the notice is shown: the conversation stays readable, and the one
 * action that lets the user keep talking sits directly over the field that no
 * longer sends. The button leaves with the notice, so the parent decides
 * where focus goes once its request is granted.
 * @param props - Whether the notice is shown and the parent-owned request for
 * a new conversation.
 * @returns The composer's deleted-agent notice.
 */
export default function ComposerDeletedAgentNotice({
  isShown,
  onStartConversation
}: ComposerDeletedAgentNoticeProps): ReactElement {
  return (
    <div className="composer__notice" data-shown={isShown ? "" : undefined}>
      <output className="composer__notice-message">
        {isShown ? DELETED_CONVERSATION_AGENT_MESSAGE : null}
      </output>
      {isShown ? (
        <Button
          className="composer__notice-action"
          onClick={onStartConversation}
          size="sm"
          type="button"
          variant="outline"
        >
          New conversation
        </Button>
      ) : null}
    </div>
  )
}
