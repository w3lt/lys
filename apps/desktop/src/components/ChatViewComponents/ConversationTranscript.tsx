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
      /** Current lifecycle error rendered after messages when defined. */
      readonly error?: string
    }

/**
 * Renders the chat transcript and its latest lifecycle error.
 *
 * @remarks The explicit variant selects
 * whether one streaming assistant follows the completed prefix. The parent
 * owns messages and lifecycle state; the transcript exposes no interruption
 * control, because cancellation must stay reachable in active phases that have
 * no assistant message and is therefore owned by the composer. Entries in the
 * completed prefix are keyed by immutable message identifier; the streaming
 * tail is rendered as the single explicit variant member, whose polite
 * Stopped/Failed status semantics are forwarded through
 * {@link StreamingChatMessage}. A lifecycle error is announced after the
 * transcript when supplied.
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
        <StreamingChatMessage message={props.streamingMessage} />
      )}
      {props.error !== undefined && (
        <ChatLifecycleError message={props.error} />
      )}
    </div>
  )
}
