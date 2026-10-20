import type { ConversationSource } from "@lys/share"
import type { ReactElement } from "react"

import type {
  CompletedConversationMessage,
  ReadonlyConversationMessage,
  StreamingConversationAssistantMessage
} from "@/lib/store/chat-view/conversation-transitions"

import ChatLifecycleError from "./ChatLifecycleError"
import ChatMessage from "./ChatMessage"
import {
  calculateReplyCitableSourceNumbers,
  listReplySources
} from "./reply-presentation"

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

/** Sources of a message that cites none. */
const NO_SOURCES: readonly ConversationSource[] = Object.freeze([])

/** What every transcript entry is shown with. */
type TranscriptEntryContext = Readonly<{
  /** Name of the agent that answers the conversation. */
  speakerName: string
  /** Numbered sources of the conversation, in number order. */
  sources: readonly ConversationSource[]
  /** Source numbers each reply may cite, by reply identifier. */
  citableSourceNumbers: ReadonlyMap<string, ReadonlySet<number>>
}>

/**
 * Builds the transcript entry of one message, keyed by its identifier.
 *
 * @param message - Message of the transcript.
 * @param replyNumber - One-based position of a reply among the replies; 0
 * for a user message.
 * @param context - Speaker name, sources, and the numbers each reply may
 * cite, shared by every entry.
 * @returns The keyed message element; a reply gets the sources it may cite.
 */
function buildTranscriptEntry(
  message: ReadonlyConversationMessage,
  replyNumber: number,
  context: TranscriptEntryContext
): ReactElement {
  const citableNumbers = context.citableSourceNumbers.get(message.id)
  return (
    <ChatMessage
      key={message.id}
      message={message}
      replyNumber={replyNumber}
      sources={
        citableNumbers === undefined
          ? NO_SOURCES
          : listReplySources(context.sources, citableNumbers)
      }
      speakerName={context.speakerName}
    />
  )
}

/**
 * Builds the transcript entries in conversation order.
 *
 * @param messages - Transcript messages in conversation order.
 * @param context - Speaker name, sources, and the numbers each reply may
 * cite, shared by every entry.
 * @returns One element per message, as {@link buildTranscriptEntry} builds
 * it; replies are numbered from 1 in order.
 */
function buildTranscriptEntries(
  messages: readonly ReadonlyConversationMessage[],
  context: TranscriptEntryContext
): ReactElement[] {
  const entries: ReactElement[] = []
  let replyCount = 0
  for (const message of messages) {
    const isReply = message.role === "assistant"
    if (isReply) replyCount += 1
    entries.push(
      buildTranscriptEntry(message, isReply ? replyCount : 0, context)
    )
  }
  return entries
}

/**
 * Renders the chat transcript and its latest lifecycle error.
 *
 * @remarks The explicit variant selects
 * whether one streaming assistant follows the completed prefix. The parent
 * owns messages, lifecycle state, the conversation's sources, and the name
 * every assistant reply is shown under. The transcript gives each reply the
 * sources its model read, so a reply's `[n]` never links to a source a later
 * reply or a failed earlier reply found. It exposes no interruption
 * control, because cancellation must stay reachable in active phases that have
 * no assistant message and is therefore owned by the composer. Every message,
 * the streaming tail included, is one entry of the same list keyed by its
 * immutable identifier, so a reply that ends updates in place and keeps its
 * open disclosures and focus. A lifecycle error is announced after the
 * transcript when supplied.
 * @param props - Completed-only or streaming-tail transcript presentation.
 * @returns The rendered transcript list and optional lifecycle error.
 */
export default function ConversationTranscript(
  props: ConversationTranscriptProps
): ReactElement {
  const messages: readonly ReadonlyConversationMessage[] =
    props.kind === "streaming-tail"
      ? [...props.completedMessages, props.streamingMessage]
      : props.completedMessages
  const entryContext: TranscriptEntryContext = {
    speakerName: props.speakerName,
    sources: props.sources,
    citableSourceNumbers: calculateReplyCitableSourceNumbers(messages)
  }

  return (
    <div className="chat-view__transcript">
      {buildTranscriptEntries(messages, entryContext)}
      {props.error !== undefined && (
        <ChatLifecycleError message={props.error} />
      )}
    </div>
  )
}
