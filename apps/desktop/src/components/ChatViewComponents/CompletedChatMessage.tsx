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
  /** Numbered sources of the conversation, in number order. */
  readonly sources: readonly ConversationSource[]
  /** Highest source number an assistant reply may cite; see {@link LysMessage}. */
  readonly sourceNumberLimit: number
}

/**
 * Selects role-specific presentation for one completed transcript message.
 *
 * @remarks The shared message object is
 * immutable; memoization skips body work while its identity, the speaker's
 * name, the identity of the conversation's sources, and the reply's source
 * number limit are unchanged.
 * @param props - Stable completed message selected by the transcript, the
 * name its assistant replies are shown under, the conversation's sources, and
 * the highest source number the reply may cite.
 * @returns The rendered role-specific transcript message.
 */
function CompletedChatMessage({
  message,
  speakerName,
  sources,
  sourceNumberLimit
}: CompletedChatMessageProps): ReactElement {
  if (message.role === "user") {
    return <UserMessage message={message} />
  }

  return (
    <LysMessage
      kind="terminal"
      message={message}
      sourceNumberLimit={sourceNumberLimit}
      sources={sources}
      speakerName={speakerName}
    />
  )
}

export default memo(CompletedChatMessage)
