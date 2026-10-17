import type { ConversationSource } from "@lys/share"
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
  /** Numbered sources of the conversation, which replies may cite. */
  readonly sources: readonly ConversationSource[]
}

/**
 * Selects role-specific presentation for one completed transcript message.
 *
 * @remarks The shared message object is
 * immutable; memoization skips body work while its identity, the speaker's
 * name, and the identity of the conversation's sources are unchanged.
 * @param props - Stable completed message selected by the transcript, the
 * name its assistant replies are shown under, and the conversation's sources.
 * @returns The rendered role-specific transcript message.
 */
function CompletedChatMessage({
  message,
  speakerName,
  sources
}: CompletedChatMessageProps): ReactElement {
  if (message.role === "user") {
    return <UserMessage message={message} />
  }

  return (
    <LysMessage
      kind="terminal"
      message={message}
      sources={sources}
      speakerName={speakerName}
    />
  )
}

export default memo(CompletedChatMessage)
