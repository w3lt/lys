import { Button } from "@/components/ui/button"
import { MarkdownMessage } from "@/components/MarkdownMessage"
import { type ConversationAssistantMessage } from "@lys/share"
import type { ReactElement } from "react"

/** Properties accepted by {@link LysMessage}. */
export type LysMessageProps = {
  /** Assistant message rendered with Markdown and lifecycle state. */
  readonly message: ConversationAssistantMessage
  /** Interrupts this message while it is streaming. */
  readonly onStop: () => void
}

/**
 * Renders one assistant message and its lifecycle controls or outcome.
 *
 * @param props - Assistant content and interruption control to present.
 * @returns The rendered assistant transcript message.
 */
export default function LysMessage({
  message,
  onStop
}: LysMessageProps): ReactElement {
  return (
    <article
      className="chat-view__message chat-view__message--lys"
      key={message.id}
    >
      <div className="chat-view__message-heading">
        <p className="chat-view__speaker">lys</p>
        {message.status === "streaming" && (
          <Button
            aria-label="Stop reply"
            onClick={onStop}
            size="sm"
            variant="ghost"
          >
            Stop
          </Button>
        )}
      </div>
      <MarkdownMessage
        streaming={message.status === "streaming"}
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
