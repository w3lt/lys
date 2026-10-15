import type { ConversationSource } from "@lys/share"
import type { ReactElement } from "react"

import type { StreamingConversationAssistantMessage } from "@/lib/store/chat-view/conversation-transitions"

import LysMessage from "./LysMessage"

/** Properties accepted by {@link StreamingChatMessage}. */
export type StreamingChatMessageProps = {
  /** Active assistant message selected from the streaming transcript tail. */
  readonly message: StreamingConversationAssistantMessage
  /** Name of the agent that answers the conversation. */
  readonly speakerName: string
  /** Numbered sources of the conversation, which replies may cite. */
  readonly sources: readonly ConversationSource[]
}

/**
 * Presents the active assistant transcript tail.
 *
 * @remarks The parent owns stream lifecycle
 * and supplies only its active assistant message. The transcript tail carries
 * no interruption control; the composer owns the single Stop control because
 * cancellation must stay reachable in active phases that have no assistant
 * message. Terminal Stopped/Failed announcements are rendered by
 * {@link LysMessage} after the parent supplies a terminal message.
 * @param props - Active assistant message to present, its speaker, and the
 * conversation's sources.
 * @returns The streaming assistant message presentation.
 */
export default function StreamingChatMessage({
  message,
  speakerName,
  sources
}: StreamingChatMessageProps): ReactElement {
  return (
    <LysMessage
      kind="streaming"
      message={message}
      sources={sources}
      speakerName={speakerName}
    />
  )
}
