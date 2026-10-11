import { memo, type ReactElement } from "react"

import type { CompletedConversationMessage } from "@/lib/store/chat-view/conversation-transitions"

import LysMessage from "./LysMessage"
import UserMessage from "./UserMessage"

/** Properties accepted by {@link CompletedChatMessage}. */
export type CompletedChatMessageProps = {
  /** Terminal or user message selected for role-specific presentation. */
  readonly message: CompletedConversationMessage
  /** Name of the agent that answers the conversation. */
  readonly speakerName: string
}

/**
 * Selects role-specific presentation for one completed transcript message.
 *
 * @remarks The shared message object is
 * immutable; memoization skips body work while its identity and the speaker's
 * name are unchanged.
 * @param props - Stable completed message selected by the transcript and the
 * name its assistant replies are shown under.
 * @returns The rendered role-specific transcript message.
 */
function CompletedChatMessage({
  message,
  speakerName
}: CompletedChatMessageProps): ReactElement {
  if (message.role === "user") {
    return <UserMessage message={message} />
  }

  return (
    <LysMessage kind="terminal" message={message} speakerName={speakerName} />
  )
}

export default memo(CompletedChatMessage)
