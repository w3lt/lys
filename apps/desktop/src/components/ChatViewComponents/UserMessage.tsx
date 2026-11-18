import type { ReactElement } from "react"

import { formatAttachmentKind } from "@/components/ComposerComponents/composer-attachments"
import type { ReadonlyConversationUserMessage } from "@/lib/store/chat-view/conversation-transitions"

import {
  formatDeliveredReportsLabel,
  type JobCardPresentation
} from "./job-presentation"
import MessageReportList from "./MessageReportList"
import SpeakerAvatar, { type TranscriptSpeaker } from "./SpeakerAvatar"

/** Properties accepted by {@link UserMessage}. */
export type UserMessageProps = {
  /** Immutable user message rendered in the completed transcript prefix. */
  readonly message: ReadonlyConversationUserMessage
  /**
   * Cards of the jobs whose reports the message delivered, in job order, as
   * the transcript lists them; empty when it delivered none.
   */
  readonly jobCards: readonly JobCardPresentation[]
  /**
   * Name of the agent that wrote the messages of the shown job; undefined in
   * a main conversation.
   */
  readonly delegatorName: string | undefined
  /**
   * One-based position of the message among the transcript's user messages:
   * the person's, a delegator's, and wake-up messages.
   */
  readonly messageNumber: number
}

/** Properties accepted by {@link AuthoredMessage}. */
type AuthoredMessageProps = {
  /** The message, which the person or a job's delegator wrote. */
  readonly message: ReadonlyConversationUserMessage
  /** One-based position of the message among the transcript's user messages. */
  readonly messageNumber: number
  /** Speaker whose portrait the message shows. */
  readonly speaker: TranscriptSpeaker
  /** Label shown beside the portrait. */
  readonly speakerName: string
  /** Cards of the jobs whose reports the message delivered. */
  readonly jobCards: readonly JobCardPresentation[]
}

/**
 * Renders a message someone wrote: its speaker, its text, its files, and the
 * reports it delivered.
 *
 * @param props - The message, its position, its speaker and label, and the
 * cards of the jobs whose reports it delivered.
 * @returns The message, with a line that opens to its reports when it
 * delivered any.
 */
function AuthoredMessage({
  message,
  messageNumber,
  speaker,
  speakerName,
  jobCards
}: AuthoredMessageProps): ReactElement {
  const reportCount = message.reports.length
  const className =
    speaker === "lys"
      ? "chat-view__message chat-view__message--lys"
      : "chat-view__message"

  return (
    <article className={className}>
      <div className="chat-view__speaker-identity">
        <SpeakerAvatar speaker={speaker} />
        <p className="chat-view__speaker">{speakerName}</p>
      </div>
      <p className="chat-view__user-copy">{message.content}</p>
      {message.attachments.length > 0 ? (
        <ul aria-label="Attached files" className="chat-view__attachments">
          {message.attachments.map((attachment) => (
            <li className="chat-view__attachment" key={attachment.number}>
              <span className="chat-view__attachment-kind">
                {formatAttachmentKind(attachment)}
              </span>
              <span className="chat-view__attachment-name">
                {attachment.name}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {reportCount > 0 && (
        <MessageReportList
          jobCards={jobCards}
          label={formatDeliveredReportsLabel(reportCount)}
          messageNumber={messageNumber}
          reports={message.reports}
        />
      )}
    </article>
  )
}

/**
 * Presents one user-role transcript message by who wrote it.
 *
 * @remarks The parent owns the immutable message, its position, list
 * identity, the cards of the jobs whose reports it delivered, and the
 * delegator's name; this component owns no state or side effects. The
 * person's message shows under `you`. A job's message, which its delegator
 * wrote, shows under the delegator's name with an agent's portrait; every
 * stored job names its delegator, so the label `agent` stands in only for a
 * name the parent did not give. Either shows the files sent with it under
 * its text, by kind and name in sending order, and, when it delivered
 * reports, a line such as `2 reports delivered with this message` that opens
 * to them. A wake-up message, which the backend wrote for the model, shows
 * only a row such as `Reports · 1` that opens to the reports it delivered,
 * never its text. The name of that line or row adds the message's position,
 * such as `Reports · 1, message 3`.
 * @param props - The message, its position, the cards of its reports' jobs,
 * and the delegator's name.
 * @returns The rendered message or reports row.
 */
export default function UserMessage({
  message,
  messageNumber,
  jobCards,
  delegatorName
}: UserMessageProps): ReactElement {
  switch (message.origin) {
    case "person":
      return (
        <AuthoredMessage
          jobCards={jobCards}
          message={message}
          messageNumber={messageNumber}
          speaker="you"
          speakerName="you"
        />
      )
    case "delegator":
      return (
        <AuthoredMessage
          jobCards={jobCards}
          message={message}
          messageNumber={messageNumber}
          speaker="lys"
          speakerName={delegatorName ?? "agent"}
        />
      )
    case "wake-up":
      return (
        <article className="chat-view__message">
          <MessageReportList
            jobCards={jobCards}
            label={`Reports · ${message.reports.length}`}
            messageNumber={messageNumber}
            reports={message.reports}
          />
        </article>
      )
  }
}
