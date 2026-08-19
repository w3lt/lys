import type { ReactElement } from "react"

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
 * @remarks Primary category: presentational. The parent owns the immutable
 * message and list identity; this component owns no state or side effects.
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
    </article>
  )
}
