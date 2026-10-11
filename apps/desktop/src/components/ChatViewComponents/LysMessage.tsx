import { MarkdownMessage } from "@/components/MarkdownMessage"
import type { ReactElement } from "react"

import type {
  StreamingConversationAssistantMessage,
  TerminalConversationAssistantMessage
} from "@/lib/store/chat-view/conversation-transitions"

import SpeakerAvatar from "./SpeakerAvatar"

/** Properties every {@link LysMessage} variant accepts. */
type LysMessageCommonProps = {
  /** Name of the agent that answers the conversation, shown as the speaker. */
  readonly speakerName: string
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
        /** Selects one assistant still accepting streamed content. */
        readonly kind: "streaming"
        /** Assistant message currently accepting streamed content. */
        readonly message: StreamingConversationAssistantMessage
      }
  )

/**
 * Renders one assistant message and its lifecycle outcome.
 *
 * @remarks The parent owns the message, its lifecycle, and the speaker's
 * name; the variant selects only whether content is still arriving. The
 * speaker is the agent that answers the conversation now, which names every
 * reply of the conversation.
 * This component exposes no interruption capability: cancellation is reachable
 * while a reply is awaited or streams, including while the turn is awaited and
 * no assistant message exists, so the composer owns the single Stop control.
 * Interrupted and failed terminal messages announce polite `Stopped` and
 * `Failed` status text respectively; those statuses are output only after the
 * corresponding terminal message variant is rendered.
 * @param props - Lifecycle-refined assistant presentation to render.
 * @returns The rendered assistant transcript message.
 */
export default function LysMessage(props: LysMessageProps): ReactElement {
  const { message, speakerName } = props

  return (
    <article className="chat-view__message chat-view__message--lys">
      <div className="chat-view__speaker-identity">
        <SpeakerAvatar speaker="lys" />
        <p className="chat-view__speaker">{speakerName}</p>
      </div>
      <MarkdownMessage
        generatingLabel={`${speakerName} is generating`}
        streaming={props.kind === "streaming"}
        text={message.content}
      />
      {message.status === "interrupted" && (
        <p aria-live="polite" className="chat-view__stopped" role="status">
          Stopped
        </p>
      )}
      {message.status === "failed" && (
        <p aria-live="polite" className="chat-view__stopped" role="status">
          Failed
        </p>
      )}
    </article>
  )
}
