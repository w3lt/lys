import type { ConversationSource } from "@lys/share"
import type { ReactElement } from "react"

import type {
  CompletedConversationMessage,
  StreamingConversationAssistantMessage
} from "@/lib/store/chat-view/conversation-transitions"

import ChatLifecycleError from "./ChatLifecycleError"
import CompletedChatMessage from "./CompletedChatMessage"
import { calculateReplySourceNumberLimits } from "./reply-presentation"
import StreamingChatMessage from "./StreamingChatMessage"

/** Properties accepted by {@link ConversationTranscript}. */
export type ConversationTranscriptProps =
  | {
      /** Selects a transcript containing only completed-prefix messages. */
      readonly kind: "completed-only"
      /** Ordered user and terminal assistant messages. */
      readonly completedMessages: readonly CompletedConversationMessage[]
      /** Name of the agent that answers the conversation. */
      readonly speakerName: string
      /** Numbered sources of the conversation, which replies may cite. */
      readonly sources: readonly ConversationSource[]
      /** Current lifecycle error rendered after messages when defined. */
      readonly error?: string
    }
  | {
      /** Selects a completed prefix with one active streaming tail. */
      readonly kind: "streaming-tail"
      /** Ordered user and terminal assistant messages before the active reply. */
      readonly completedMessages: readonly CompletedConversationMessage[]
      /** Final assistant message accepting streamed parts. */
      readonly streamingMessage: StreamingConversationAssistantMessage
      /** Name of the agent that answers the conversation. */
      readonly speakerName: string
      /** Numbered sources of the conversation, which replies may cite. */
      readonly sources: readonly ConversationSource[]
      /** Current lifecycle error rendered after messages when defined. */
      readonly error?: string
    }

/** What every completed transcript entry is shown with. */
type CompletedEntryContext = Readonly<{
  /** Name of the agent that answers the conversation. */
  speakerName: string
  /** Numbered sources of the conversation, in number order. */
  sources: readonly ConversationSource[]
  /** Highest source number each reply may cite, by reply identifier. */
  sourceNumberLimits: ReadonlyMap<string, number>
}>

/**
 * Builds the transcript entry of one completed message, keyed by its
 * identifier.
 *
 * @param message - Completed message of the transcript.
 * @param context - Speaker name, sources, and source number limits shared by
 * every entry.
 * @returns The keyed message element.
 */
function buildCompletedEntry(
  message: CompletedConversationMessage,
  context: CompletedEntryContext
): ReactElement {
  return (
    <CompletedChatMessage
      key={message.id}
      message={message}
      sourceNumberLimit={context.sourceNumberLimits.get(message.id) ?? 0}
      sources={context.sources}
      speakerName={context.speakerName}
    />
  )
}

/**
 * Renders the chat transcript and its latest lifecycle error.
 *
 * @remarks The explicit variant selects
 * whether one streaming assistant follows the completed prefix. The parent
 * owns messages, lifecycle state, the conversation's sources, and the name
 * every assistant reply is shown under. The transcript gives each reply the
 * highest source number it may cite, so a reply's `[n]` never links to a
 * source a later reply found. It exposes no interruption
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
  const sourceNumberLimits = calculateReplySourceNumberLimits(
    props.kind === "streaming-tail"
      ? [...props.completedMessages, props.streamingMessage]
      : props.completedMessages
  )
  const entryContext: CompletedEntryContext = {
    speakerName: props.speakerName,
    sources: props.sources,
    sourceNumberLimits
  }

  return (
    <div className="chat-view__transcript">
      {props.completedMessages.map((message) =>
        buildCompletedEntry(message, entryContext)
      )}
      {props.kind === "streaming-tail" && (
        <StreamingChatMessage
          message={props.streamingMessage}
          sourceNumberLimit={
            sourceNumberLimits.get(props.streamingMessage.id) ?? 0
          }
          sources={props.sources}
          speakerName={props.speakerName}
        />
      )}
      {props.error !== undefined && (
        <ChatLifecycleError message={props.error} />
      )}
    </div>
  )
}
