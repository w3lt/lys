import { MarkdownMessage } from "@/components/MarkdownMessage"
import type { ReactElement } from "react"

import type {
  StreamingConversationAssistantMessage,
  TerminalConversationAssistantMessage
} from "@/lib/store/chat-view/conversation-transitions"

import SpeakerAvatar from "./SpeakerAvatar"

/** Properties accepted by {@link LysMessage}. */
export type LysMessageProps =
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

/**
 * Renders one assistant message and its lifecycle outcome.
 *
 * @remarks Primary category: presentational. The parent owns the message and
 * its lifecycle; the variant selects only whether content is still arriving.
 * This component exposes no interruption capability: cancellation is reachable
 * in every active request phase, including phases with no assistant message,
 * so the composer owns the single Stop control. Interrupted and failed
 * terminal messages announce polite `Stopped` and `Failed` status text
 * respectively; those statuses are output only after the corresponding
 * terminal message variant is rendered.
 * @param props - Lifecycle-refined assistant presentation to render.
 * @returns The rendered assistant transcript message.
 */
export default function LysMessage(props: LysMessageProps): ReactElement {
  const { message } = props

  return (
    <article className="chat-view__message chat-view__message--lys">
      <div className="chat-view__speaker-identity">
        <SpeakerAvatar speaker="lys" />
        <p className="chat-view__speaker">lys</p>
      </div>
      <MarkdownMessage
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
