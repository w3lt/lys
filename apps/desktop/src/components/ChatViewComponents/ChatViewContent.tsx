import type {
  ConversationAssistantMessage,
  ConversationMessage
} from "@lys/share"
import { ArrowDown } from "lucide-react"
import { lazy, type ReactElement, type RefObject } from "react"

import { Button } from "../ui/button"

/** Lazy empty-conversation view rendered before a transcript exists. */
const StarterView = lazy(
  () => import("@/components/ChatViewComponents/StarterView")
)

/** Lazy transcript renderer used after the conversation begins or fails. */
const ConversationContent = lazy(
  () => import("@/components/ChatViewComponents/ConversationContent")
)

/** Transcript partitions rendered by {@link ChatViewContent}. */
type ConversationPresentation = {
  /** Stable transcript prefix without the active streaming assistant. */
  readonly completedMessages: readonly ConversationMessage[]
  /** Final assistant message while it is accepting stream deltas. */
  readonly streamingMessage?: ConversationAssistantMessage
}

/** Properties accepted by {@link ChatViewContent}. */
export type ChatViewContentProps = {
  /** Ordered messages selected from the active shared conversation. */
  readonly messages: readonly ConversationMessage[]
  /** Records scrolling within the transcript host. */
  readonly handleScroll: () => void
  /** Restores the parent-owned pinned-to-latest transcript position. */
  readonly jumpToLatest: () => void
  /** Parent-owned transcript host used for scrolling. */
  readonly transcriptRef: RefObject<HTMLDivElement | null>
  /** Current lifecycle failure displayed after the transcript when defined. */
  readonly error?: string
  /** Sends an optional starter prompt and resolves after the request completes. */
  readonly sendMessage: (message?: string | undefined) => Promise<void>
  /** Interrupts the final assistant message while it is streaming. */
  readonly stopStreaming: () => void
  /** Whether reply generation remains active for live-status announcement. */
  readonly isReplyPending: boolean
  /** Whether the transcript already displays its latest content. */
  readonly atBottom: boolean
}

/**
 * Presents the empty state or transcript and its navigation affordances.
 *
 * @remarks Primary category: presentational. The parent owns conversation
 * state, transcript position, scrolling, submission, and interruption; this
 * component projects them into the conversation landmark.
 * @param props - Parent-owned conversation state and transcript controls.
 * @returns The conversation landmark with empty or transcript content.
 */
export default function ChatViewContent({
  messages,
  handleScroll,
  jumpToLatest,
  transcriptRef,
  error,
  sendMessage,
  stopStreaming,
  atBottom,
  isReplyPending
}: ChatViewContentProps): ReactElement {
  const presentation = createConversationPresentation(messages)

  return (
    <section className="chat-view" aria-label="Conversation">
      <div
        className="chat-view__scroller"
        data-testid="transcript"
        onScroll={handleScroll}
        ref={transcriptRef}
      >
        {messages.length === 0 && !error ? (
          <StarterView onSend={(prompt) => void sendMessage(prompt)} />
        ) : "streamingMessage" in presentation ? (
          <ConversationContent
            completedMessages={presentation.completedMessages}
            error={error}
            onStop={stopStreaming}
            streamingMessage={presentation.streamingMessage}
          />
        ) : (
          <ConversationContent
            completedMessages={presentation.completedMessages}
            error={error}
          />
        )}
      </div>

      {!atBottom && (
        <Button
          className="chat-view__jump"
          onClick={jumpToLatest}
          size="sm"
          variant="outline"
        >
          <ArrowDown aria-hidden="true" />
          Jump to latest
        </Button>
      )}

      <span aria-live="polite" className="sr-only" role="status">
        {isReplyPending ? "Lys is generating a reply" : ""}
      </span>
    </section>
  )
}

/**
 * Separates an active streaming assistant from prior transcript messages.
 *
 * @param messages - Ordered messages from the active shared conversation.
 * @returns Completed messages and the optional streaming assistant tail.
 */
function createConversationPresentation(
  messages: readonly ConversationMessage[]
): ConversationPresentation {
  const finalMessage = messages.at(-1)
  if (
    finalMessage?.role !== "assistant" ||
    finalMessage.status !== "streaming"
  ) {
    return { completedMessages: messages }
  }

  return {
    completedMessages: messages.slice(0, -1),
    streamingMessage: finalMessage
  }
}
