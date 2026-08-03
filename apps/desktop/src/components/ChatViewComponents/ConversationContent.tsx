import ChatMessage from "./ChatMessage"
import { type ConversationMessage } from "@lys/share"
import type { ReactElement } from "react"

import ChatLifecycleError from "./ChatLifecycleError"

/** Properties accepted by {@link ConversationContent}. */
export type ConversationContentProps = {
  /** Ordered conversation messages displayed in the transcript. */
  readonly messages: readonly ConversationMessage[]
  /** Current lifecycle error rendered after transcript messages. */
  readonly error?: string
  /** Interrupts the active assistant reply. */
  readonly onStop: () => void
}

/**
 * Renders the chat transcript and its latest lifecycle error.
 *
 * @param props - Transcript messages and lifecycle controls to present.
 * @returns The rendered transcript region.
 */
export default function ConversationContent({
  error,
  messages,
  onStop
}: ConversationContentProps): ReactElement {
  return (
    <div className="chat-view__transcript">
      {messages.map((message) => (
        <ChatMessage key={message.id} message={message} onStop={onStop} />
      ))}
      {error !== undefined && <ChatLifecycleError message={error} />}
    </div>
  )
}
