import { MarkdownMessage } from "@/components/MarkdownMessage"
import type { ConversationSource } from "@lys/share"
import type { ReactElement } from "react"

import type {
  StreamingConversationAssistantMessage,
  TerminalConversationAssistantMessage
} from "@/lib/store/chat-view/conversation-transitions"

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
 * Renders one assistant message: its reasoning, its steps, its answer, its
 * sources, and its lifecycle outcome.
 *
 * @remarks The parent owns the message, its lifecycle, the sources the reply
 * may cite, the reply's position, and the speaker's name; the variant selects
 * only whether parts are still arriving. The speaker is the agent that
 * answers the conversation now, which names every reply of the conversation.
 * The reasoning and the steps, shown only when the reply has them, start
 * collapsed; the steps say how long the reply worked once it ended. The
 * controls' names add the reply's position, so the same control of two
 * replies has different names. The answer is the text of the reply's last
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
 * sources it may cite, its position, and the speaker's name.
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
