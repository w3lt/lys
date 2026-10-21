import type { ReactElement } from "react"

import { formatAttachmentKind } from "@/components/ComposerComponents/composer-attachments"
import type { ReadonlyConversationUserMessage } from "@/lib/store/chat-view/conversation-transitions"

import SpeakerAvatar from "./SpeakerAvatar"

/** Properties accepted by {@link UserMessage}. */
export type UserMessageProps = {
  /** Immutable user message rendered in the completed transcript prefix. */
  readonly message: ReadonlyConversationUserMessage
}

/**
 * Presents one user-authored transcript message.
 *
 * @remarks The parent owns the immutable
 * message and list identity; this component owns no state or side effects.
 * The files sent with the message are listed under its text by kind and
 * name, in the order they were sent; a message without files lists nothing.
 * @param props - Completed user message selected by the transcript.
 * @returns The rendered user message.
 */
export default function UserMessage({
  message
}: UserMessageProps): ReactElement {
  return (
    <article className="chat-view__message">
      <div className="chat-view__speaker-identity">
        <SpeakerAvatar speaker="you" />
        <p className="chat-view__speaker">you</p>
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
    </article>
  )
}
