import { MarkdownMessage } from "@/components/MarkdownMessage"
import type { ConversationSource, Job } from "@lys/share"
import type { ReactElement } from "react"

import type {
  StreamingConversationAssistantMessage,
  TerminalConversationAssistantMessage
} from "@/lib/store/chat-view/conversation-transitions"

import {
  createReplyJobsPresentation,
  type JobCardPresentation
} from "./job-presentation"
import ReplyJobList from "./ReplyJobList"
import {
  calculateReplyWorkDuration,
  createReplyPresentation,
  createReplySourcesPresentation,
  formatReplyOutcome
} from "./reply-presentation"
import ReplyReasoning from "./ReplyReasoning"
import ReplySourceList from "./ReplySourceList"
import ReplySteps from "./ReplySteps"
import SpeakerAvatar from "./SpeakerAvatar"

/** Properties every {@link LysMessage} variant accepts. */
type LysMessageCommonProps = {
  /** Name of the agent that answers the conversation, shown as the speaker. */
  readonly speakerName: string
  /**
   * Sources the reply may cite, in number order: those its model read, as
   * the transcript lists them.
   */
  readonly sources: readonly ConversationSource[]
  /** One-based position of the reply among the transcript's replies. */
  readonly replyNumber: number
  /**
   * Cards of the jobs the reply's tool calls sent a message, in job order,
   * as the transcript lists them; empty when it sent none.
   */
  readonly jobCards: readonly JobCardPresentation[]
  /** Opens a job's conversation; receives the job's identity. */
  readonly onOpenJob: (jobId: string) => void
  /** Stops a job's latest reply; receives the job. */
  readonly onStopJob: (job: Job) => void
}

/** Properties accepted by {@link LysMessage}. */
export type LysMessageProps = LysMessageCommonProps &
  (
    | {
        /** Selects one terminal assistant whose lifecycle has ended. */
        readonly kind: "terminal"
        /** Assistant message whose lifecycle has ended. */
        readonly message: TerminalConversationAssistantMessage
      }
    | {
        /** Selects one assistant still accepting streamed parts. */
        readonly kind: "streaming"
        /** Assistant message currently accepting streamed parts. */
        readonly message: StreamingConversationAssistantMessage
      }
  )

/**
 * Renders one assistant message: its reasoning, its steps, the jobs it sent
 * a message, its answer, its sources, and its lifecycle outcome.
 *
 * @remarks The parent owns the message, its lifecycle, the sources the reply
 * may cite, the reply's position, the speaker's name, the cards of the jobs
 * the reply sent a message, and what opening and stopping a job do; the
 * variant selects only whether parts are still arriving. The speaker is the
 * agent that answers the conversation now, which names every reply of the
 * conversation. The reasoning and the steps, shown only when the reply has
 * them, start collapsed; the steps say how long the reply worked once it
 * ended. The controls' names add the reply's position, so the same control
 * of two replies has different names. Between the steps and the answer, the
 * reply shows the card of each job it started and a link to the card of each
 * job it only continued; a `delegate_work` call whose job is not listed stays
 * an ordinary step. The answer is the text of the reply's last
 * round when that round called no tools, rendered as Markdown whose `[n]`
 * markers in prose link to the sources the reply may cite. The sources the
 * answer links, in the order the store listed its citations, and those its
 * calls found without citing, are listed under the answer when there are
 * any. Both variants render the same elements, so a reply that ends keeps
 * its open disclosures and focus.
 * This component exposes no interruption capability: cancellation is reachable
 * while a reply is awaited or streams, including while the turn is awaited and
 * no assistant message exists, so the composer owns the single Stop control.
 * Interrupted and failed terminal messages announce polite `Stopped` and
 * `Failed` status text respectively; those statuses are output only after the
 * corresponding terminal message variant is rendered.
 * @param props - Lifecycle-refined assistant presentation to render, the
 * sources it may cite, its position, the speaker's name, and its jobs with
 * their open and stop callbacks.
 * @returns The rendered assistant transcript message.
 */
export default function LysMessage(props: LysMessageProps): ReactElement {
  const { message, replyNumber, sources, speakerName } = props
  const isStreaming = props.kind === "streaming"
  const reply = createReplyPresentation(message.parts, isStreaming)
  const replySources = createReplySourcesPresentation(
    message.parts,
    message.answerCitationNumbers,
    sources
  )
  const hasReplySources =
    replySources.cited.length > 0 || replySources.found.length > 0
  const replyJobs = createReplyJobsPresentation(message.parts, props.jobCards)
  const outcome = formatReplyOutcome(message.status)

  return (
    <article className="chat-view__message chat-view__message--lys">
      <div className="chat-view__speaker-identity">
        <SpeakerAvatar speaker="lys" />
        <p className="chat-view__speaker">{speakerName}</p>
      </div>
      {reply.reasoning !== undefined && (
        <ReplyReasoning reasoning={reply.reasoning} replyNumber={replyNumber} />
      )}
      {reply.steps.length > 0 && (
        <ReplySteps
          replyNumber={replyNumber}
          steps={reply.steps}
          workedMs={
            isStreaming ? undefined : calculateReplyWorkDuration(message)
          }
        />
      )}
      <ReplyJobList
        jobs={replyJobs}
        onOpenJob={props.onOpenJob}
        onStopJob={props.onStopJob}
      />
      <MarkdownMessage
        generatingLabel={`${speakerName} is generating`}
        sources={sources}
        streaming={isStreaming}
        text={reply.answer}
      />
      {hasReplySources && (
        <ReplySourceList replyNumber={replyNumber} sources={replySources} />
      )}
      {outcome !== undefined && (
        <p aria-live="polite" className="chat-view__stopped" role="status">
          {outcome}
        </p>
      )}
    </article>
  )
}
