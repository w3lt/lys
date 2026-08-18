import { memo, type ReactElement } from "react"

import type { CompletedConversationMessage } from "@/lib/store/chat-view/conversation-transitions"

import LysMessage from "./LysMessage"
import UserMessage from "./UserMessage"

/** Properties accepted by {@link CompletedChatMessage}. */
export type CompletedChatMessageProps = {
  /** Terminal or user message selected for role-specific presentation. */
  readonly message: CompletedConversationMessage
}

/**
 * Selects role-specific presentation for one completed transcript message.
 *
 * @remarks Primary category: presentational. The shared message object is
 * immutable; memoization skips body work while its identity is unchanged.
 * @param props - Stable completed message selected by the transcript.
 * @returns The rendered role-specific transcript message.
 */
function CompletedChatMessage({
  message
}: CompletedChatMessageProps): ReactElement {
  if (message.role === "user") {
    return <UserMessage message={message} />
  }

  return <LysMessage kind="terminal" message={message} />
}

export default memo(CompletedChatMessage)
