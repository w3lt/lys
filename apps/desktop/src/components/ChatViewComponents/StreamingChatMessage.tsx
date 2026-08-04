import { type ConversationAssistantMessage } from "@lys/share"
import type { ReactElement } from "react"

import LysMessage from "./LysMessage"

/** Properties accepted by {@link StreamingChatMessage}. */
export type StreamingChatMessageProps = {
  /** Active assistant message selected from the streaming transcript tail. */
  readonly message: ConversationAssistantMessage
  /** Interrupts the message when it is the active assistant reply. */
  readonly onStop: () => void
}

/**
 * Presents the active assistant transcript tail with its interruption control.
 *
 * @remarks Primary category: presentational. The parent owns stream lifecycle
 * and provides the interruption action only for its active assistant message.
 * @param props - Active assistant message and its interruption control.
 * @returns The streaming assistant message presentation.
 */
export default function StreamingChatMessage({
  message,
  onStop
}: StreamingChatMessageProps): ReactElement {
  return <LysMessage message={message} onStop={onStop} />
}
