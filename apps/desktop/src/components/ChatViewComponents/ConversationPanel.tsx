import { ArrowDown } from "lucide-react"
import type { ReactElement, RefObject } from "react"

import { Button } from "../ui/button"
import type {
  CompletedConversationPresentation,
  ConversationActivity,
  StreamingConversationPresentation
} from "./conversation-presentation"
import ConversationTranscript from "./ConversationTranscript"
import StarterView from "./StarterView"

/** Parent-owned controls shared by every {@link ConversationPanel} variant. */
type ConversationPanelCommonProps = {
  /** Records scrolling within the transcript host. */
  readonly onTranscriptScroll: () => void
  /** Restores the parent-owned pinned-to-latest transcript position. */
  readonly onJumpToLatest: () => void
  /** Parent-owned transcript host used for scrolling. */
  readonly transcriptRef: RefObject<HTMLDivElement | null>
  /** Current lifecycle failure displayed after the transcript when defined. */
  readonly error?: string
  /** Sends an optional starter prompt and resolves after request settlement. */
  readonly onSendMessage: (message?: string) => Promise<void>
  /** Work the region is waiting on, announced as a polite status. */
  readonly activity: ConversationActivity
  /** Whether the transcript already displays its latest content. */
  readonly isAtBottom: boolean
}

/**
 * Formats the polite status announced for the region's pending work.
 *
 * @param activity - Work the region is waiting on.
 * @returns The announcement, or empty text when nothing is pending.
 */
function formatConversationActivity(activity: ConversationActivity): string {
  switch (activity) {
    case "idle":
      return ""
    case "generating-reply":
      return "Lys is generating a reply"
    case "opening-conversation":
      return "Opening conversation"
  }
}

/** Properties accepted by {@link ConversationPanel}. */
export type ConversationPanelProps =
  | (ConversationPanelCommonProps & CompletedConversationPresentation)
  | (ConversationPanelCommonProps &
      StreamingConversationPresentation & {
        /** Interrupts the active assistant reply. */
        readonly onStopReply: () => void
      })

/**
 * Presents the conversation transcript and its navigation affordances.
 *
 * @remarks Primary category: presentational. The parent owns conversation
 * state, transcript position, scrolling, submission, and interruption. The
 * Stop action exists only in the streaming-tail contract. Starter clicks call
 * `onSendMessage` once and intentionally discard its settlement because the
 * store owns request failure state. The transcript host is the supplied ref
 * target and exposes native scroll semantics; the jump control appears only
 * when the parent reports that the reader is away from the latest content.
 * A polite status announces a pending reply or conversation open, and the
 * landmark is marked busy while its content is being replaced by an open.
 * @param props - Parent-owned presentation state and transcript controls.
 * @returns The conversation landmark with starter or transcript content.
 */
export default function ConversationPanel(
  props: ConversationPanelProps
): ReactElement {
  const {
    onTranscriptScroll,
    onJumpToLatest,
    transcriptRef,
    error,
    onSendMessage,
    isAtBottom,
    activity
  } = props
  const isEmptyConversation =
    props.kind === "completed-only" &&
    props.completedMessages.length === 0 &&
    error === undefined
  const transcript =
    props.kind === "streaming-tail" ? (
      <ConversationTranscript
        kind="streaming-tail"
        completedMessages={props.completedMessages}
        error={error}
        onStopReply={props.onStopReply}
        streamingMessage={props.streamingMessage}
      />
    ) : (
      <ConversationTranscript
        kind="completed-only"
        completedMessages={props.completedMessages}
        error={error}
      />
    )
  const conversationBody = isEmptyConversation ? (
    <StarterView onSend={(prompt) => void onSendMessage(prompt)} />
  ) : (
    transcript
  )

  return (
    <section
      aria-busy={activity === "opening-conversation"}
      aria-label="Conversation"
      className="chat-view"
    >
      <div
        className="chat-view__scroller"
        data-testid="transcript"
        onScroll={onTranscriptScroll}
        ref={transcriptRef}
      >
        {conversationBody}
      </div>

      {!isAtBottom && (
        <Button
          className="chat-view__jump"
          onClick={onJumpToLatest}
          size="sm"
          variant="outline"
        >
          <ArrowDown aria-hidden="true" />
          Jump to latest
        </Button>
      )}

      <span aria-live="polite" className="sr-only" role="status">
        {formatConversationActivity(activity)}
      </span>
    </section>
  )
}
