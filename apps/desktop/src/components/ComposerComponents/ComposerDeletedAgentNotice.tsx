import type { ReactElement } from "react"

import { Button } from "@/components/ui/button"
import { DELETED_CONVERSATION_AGENT_MESSAGE } from "@/lib/apis/http/chat"

/** Properties accepted by {@link ComposerDeletedAgentNotice}. */
export type ComposerDeletedAgentNoticeProps = {
  /** Invoked once when the user asks for a new conversation. */
  readonly onStartConversation: () => void
}

/**
 * States that the shown conversation's agent was deleted and offers a new
 * conversation.
 *
 * @remarks The parent decides when the notice applies and owns the callback;
 * this component owns no state, effects, or resources. The notice is a polite
 * status region above the field, which the parent disables: the conversation
 * stays readable, and the one action that lets the user keep talking sits
 * directly over the field that no longer sends.
 * @param props - Parent-owned request for a new conversation.
 * @returns The composer's deleted-agent notice.
 */
export default function ComposerDeletedAgentNotice({
  onStartConversation
}: ComposerDeletedAgentNoticeProps): ReactElement {
  return (
    <div aria-live="polite" className="composer__notice" role="status">
      <span className="composer__notice-message">
        {DELETED_CONVERSATION_AGENT_MESSAGE}
      </span>
      <Button
        className="composer__notice-action"
        onClick={onStartConversation}
        size="sm"
        type="button"
        variant="outline"
      >
        New conversation
      </Button>
    </div>
  )
}
