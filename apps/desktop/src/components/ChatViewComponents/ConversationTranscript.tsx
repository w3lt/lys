import type { ReactElement } from "react"

import type {
  CompletedConversationMessage,
  StreamingConversationAssistantMessage
} from "@/lib/store/chat-view/conversation-transitions"

import ChatLifecycleError from "./ChatLifecycleError"
import CompletedChatMessage from "./CompletedChatMessage"
import StreamingChatMessage from "./StreamingChatMessage"

/** Properties accepted by {@link ConversationTranscript}. */
export type ConversationTranscriptProps =
  | {
      /** Selects a transcript containing only completed-prefix messages. */
      readonly kind: "completed-only"
      /** Ordered user and terminal assistant messages. */
      readonly completedMessages: readonly CompletedConversationMessage[]
      /** Current lifecycle error rendered after messages when defined. */
      readonly error?: string
    }
  | {
      /** Selects a completed prefix with one active streaming tail. */
      readonly kind: "streaming-tail"
      /** Ordered user and terminal assistant messages before the active reply. */
      readonly completedMessages: readonly CompletedConversationMessage[]
      /** Final assistant message accepting streamed content. */
      readonly streamingMessage: StreamingConversationAssistantMessage
      /** Interrupts the active assistant reply. */
      readonly onStopReply: () => void
      /** Current lifecycle error rendered after messages when defined. */
      readonly error?: string
    }

/**
 * Renders the chat transcript and its latest lifecycle error.
 *
 * @remarks Primary category: presentational. The explicit variant permits an
 * interruption action only when one streaming assistant follows the completed
 * prefix. The parent owns messages, lifecycle state, and interruption.
 * @param props - Completed-only or streaming-tail transcript presentation.
 * @returns The rendered transcript list and optional lifecycle error.
 */
export default function ConversationTranscript(
  props: ConversationTranscriptProps
): ReactElement {
  return (
    <div className="chat-view__transcript">
      {props.completedMessages.map((message) => (
        <CompletedChatMessage key={message.id} message={message} />
      ))}
      {props.kind === "streaming-tail" && (
        <StreamingChatMessage
          message={props.streamingMessage}
          onStopReply={props.onStopReply}
        />
      )}
      {props.error !== undefined && (
        <ChatLifecycleError message={props.error} />
      )}
    </div>
  )
}
