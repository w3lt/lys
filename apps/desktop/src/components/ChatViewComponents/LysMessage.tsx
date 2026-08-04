import { Button } from "@/components/ui/button"
import { MarkdownMessage } from "@/components/MarkdownMessage"
import type { ReactElement } from "react"

import type {
  StreamingConversationAssistantMessage,
  TerminalConversationAssistantMessage
} from "@/lib/store/chat-view/conversation-transitions"

/** Properties accepted by {@link LysMessage}. */
export type LysMessageProps =
  | {
      /** Selects one terminal assistant with no interruption capability. */
      readonly kind: "terminal"
      /** Assistant message whose lifecycle has ended. */
      readonly message: TerminalConversationAssistantMessage
    }
  | {
      /** Selects one active assistant with an interruption capability. */
      readonly kind: "streaming"
      /** Assistant message currently accepting streamed content. */
      readonly message: StreamingConversationAssistantMessage
      /** Interrupts the active assistant reply. */
      readonly onStopReply: () => void
    }

/**
 * Renders one assistant message and its lifecycle controls or outcome.
 *
 * @remarks Primary category: presentational. An interruption action is shown
 * only by the streaming variant; terminal variants expose no Stop capability.
 * @param props - Lifecycle-refined assistant presentation to render.
 * @returns The rendered assistant transcript message.
 */
export default function LysMessage(props: LysMessageProps): ReactElement {
  const { message } = props

  return (
    <article className="chat-view__message chat-view__message--lys">
      <div className="chat-view__message-heading">
        <p className="chat-view__speaker">lys</p>
        {props.kind === "streaming" && (
          <Button
            aria-label="Stop reply"
            onClick={props.onStopReply}
            size="sm"
            variant="ghost"
          >
            Stop
          </Button>
        )}
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
