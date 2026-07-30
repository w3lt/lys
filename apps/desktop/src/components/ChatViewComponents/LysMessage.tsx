import { type LysMessage } from "@/app/types"
import { Button } from "@/components/ui/button"
import { MarkdownMessage } from "@/components/MarkdownMessage"

type LysMessageProps = {
  message: LysMessage
}

export default function LysMessage({
  message
}: LysMessageProps) {
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
            // onClick={onStop}
            size="sm"
            variant="ghost"
          >
            Stop
          </Button>
        )}
      </div>
      <MarkdownMessage
        streaming={message.status === "streaming"}
        text={message.text}
      />
      {message.status === "stopped" && (
        <p aria-live="polite" className="chat-view__stopped" role="status">
          Stopped
        </p>
      )}
    </article>
  )
}