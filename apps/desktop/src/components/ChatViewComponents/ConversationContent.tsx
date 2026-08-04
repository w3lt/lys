import CompletedChatMessage from "./CompletedChatMessage"
import {
  type ConversationAssistantMessage,
  type ConversationMessage
} from "@lys/share"
import type { ReactElement } from "react"

import ChatLifecycleError from "./ChatLifecycleError"
import StreamingChatMessage from "./StreamingChatMessage"

/** Properties accepted by {@link ConversationContent}. */
export type ConversationContentProps =
  | {
      /** Ordered conversation messages displayed in the transcript. */
      readonly completedMessages: readonly ConversationMessage[]

      /** Current lifecycle error rendered after transcript messages. */
      readonly error?: string
    }
  | {
      /** Ordered conversation messages displayed in the transcript. */
      readonly completedMessages: readonly ConversationMessage[]

      /** Current lifecycle error rendered after transcript messages. */
      readonly error?: string

      /** Final assistant message while it is accepting stream deltas. */
      readonly streamingMessage: ConversationAssistantMessage
      /** Interrupts the active assistant reply. */
      readonly onStop: () => void
    }

/**
 * Renders the chat transcript and its latest lifecycle error.
 *
 * @remarks Primary category: presentational. The parent selects either a
 * completed-only transcript or one active assistant tail with its paired
 * interruption action.
 * @param props - Transcript messages, optional streaming tail, and error.
 * @returns The rendered transcript region.
 */
export default function ConversationContent(
  props: ConversationContentProps
): ReactElement {
  const { completedMessages, error } = props
  return (
    <div className="chat-view__transcript">
      {completedMessages.map((message) => (
        <CompletedChatMessage key={message.id} message={message} />
      ))}
      {"streamingMessage" in props && (
        <StreamingChatMessage
          message={props.streamingMessage}
          onStop={props.onStop}
        />
      )}
      {error !== undefined && <ChatLifecycleError message={error} />}
    </div>
  )
}
