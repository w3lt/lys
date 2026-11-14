import type { ConversationSource, Job } from "@lys/share"
import { ArrowDown } from "lucide-react"
import type { ReactElement, RefObject } from "react"

import { Button } from "../ui/button"
import type {
  ConversationActivity,
  ConversationPresentation
} from "./conversation-presentation"
import ConversationTranscript from "./ConversationTranscript"
import type { JobCardPresentation } from "./job-presentation"
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
  /**
   * Name of the agent that answers the conversation, shown on every reply
   * and named in the pending-work status.
   */
  readonly agentName: string
  /**
   * Name of the agent that wrote the messages of the shown job; undefined in
   * a main conversation.
   */
  readonly delegatorName: string | undefined
  /** Numbered sources of the conversation, which replies may cite. */
  readonly sources: readonly ConversationSource[]
  /** Cards of every job of the conversation, in number order. */
  readonly jobCards: readonly JobCardPresentation[]
  /** Opens a job's conversation; receives the job's identity. */
  readonly onOpenJob: (jobId: string) => void
  /** Stops a job's latest reply; receives the job. */
  readonly onStopJob: (job: Job) => void
}

/**
 * Formats the polite status announced for the region's pending work.
 *
 * @param activity - Work the region is waiting on.
 * @param agentName - Name of the agent that answers the conversation.
 * @returns The announcement, or empty text when nothing is pending.
 */
function formatConversationActivity(
  activity: ConversationActivity,
  agentName: string
): string {
  switch (activity) {
    case "idle":
      return ""
    case "generating-reply":
      return `${agentName} is generating a reply`
    case "opening-conversation":
      return "Opening conversation"
  }
}

/** Properties accepted by {@link ConversationPanel}. */
export type ConversationPanelProps = ConversationPanelCommonProps &
  ConversationPresentation

/**
 * Builds the content the panel scrolls: the starter view while the
 * conversation is empty, otherwise the transcript.
 *
 * @param props - The panel's properties.
 * @returns The starter view for an empty conversation without a lifecycle
 * error, whose prompts call `onSendMessage` and discard its settlement;
 * otherwise the transcript of the presentation's variant, with the error
 * after it.
 */
function buildConversationBody(props: ConversationPanelProps): ReactElement {
  const isEmptyConversation =
    props.kind === "completed-only" &&
    props.completedMessages.length === 0 &&
    props.error === undefined
  if (isEmptyConversation) {
    return (
      <StarterView
        onSendStarterPrompt={(prompt) => void props.onSendMessage(prompt)}
      />
    )
  }

  const transcriptProps = {
    delegatorName: props.delegatorName,
    error: props.error,
    jobCards: props.jobCards,
    onOpenJob: props.onOpenJob,
    onStopJob: props.onStopJob,
    sources: props.sources,
    speakerName: props.agentName
  }
  return props.kind === "streaming-tail" ? (
    <ConversationTranscript
      {...transcriptProps}
      completedMessages={props.completedMessages}
      kind="streaming-tail"
      streamingMessage={props.streamingMessage}
    />
  ) : (
    <ConversationTranscript
      {...transcriptProps}
      completedMessages={props.completedMessages}
      kind="completed-only"
    />
  )
}

/**
 * Presents the conversation transcript and its navigation affordances.
 *
 * @remarks The parent owns conversation state, sources, and jobs, transcript
 * position, scrolling, submission, what opening and stopping a job do, the
 * name of the agent that answers, and, in a job, the name of its delegator.
 * The panel exposes no interruption control, because cancellation must stay
 * reachable in active phases that have no assistant message and is therefore
 * owned by the composer. Starter clicks call `onSendMessage` once and intentionally discard
 * its settlement because the store owns request failure state. The transcript
 * host is the supplied ref target and exposes native scroll semantics; the
 * jump control appears only when the parent reports that the reader is away
 * from the latest content. A polite status announces a pending reply or
 * conversation open, and the landmark is marked busy while its content is
 * being replaced by an open.
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
    isAtBottom,
    activity,
    agentName
  } = props

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
        {buildConversationBody(props)}
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
        {formatConversationActivity(activity, agentName)}
      </span>
    </section>
  )
}
