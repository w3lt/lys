import { useEffect, useRef } from "react"
import { ArrowDown, ArrowRight } from "lucide-react"

import { STARTER_PROMPTS } from "@/app/content"
import type { Message } from "@/app/types"
import { MarkdownMessage } from "@/components/MarkdownMessage"
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert"
import { Button } from "@/components/ui/button"

import "./ChatView.css"

interface ChatViewProps {
  messages: Message[]
  streaming: boolean
  atBottom: boolean
  onScrollPositionChange: (atBottom: boolean) => void
  onSend: (text: string) => void
  onRetry: () => void
  onStop: () => void
}

export function ChatView({
  messages,
  streaming,
  atBottom,
  onScrollPositionChange,
  onSend,
  onRetry,
  onStop,
}: ChatViewProps) {
  const transcriptRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = transcriptRef.current

    if (!element || !atBottom || messages.length === 0) return

    element.scrollTo?.({ top: element.scrollHeight })
  }, [atBottom, messages])

  function handleScroll() {
    const element = transcriptRef.current
    if (!element) return

    const nearBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight < 120
    onScrollPositionChange(nearBottom)
  }

  function jumpToLatest() {
    const element = transcriptRef.current
    if (!element) return

    element.scrollTo?.({ top: element.scrollHeight, behavior: "smooth" })
    onScrollPositionChange(true)
  }

  return (
    <section className="chat-view" aria-label="Conversation">
      <div
        className="chat-view__scroller"
        data-testid="transcript"
        onScroll={handleScroll}
        ref={transcriptRef}
      >
        {messages.length === 0 ? (
          <div className="chat-view__empty">
            <div aria-hidden="true" className="chat-view__mark">
              L
            </div>
            <p className="chat-view__eyebrow">local inference interface</p>
            <h1>Lysiptera Caliginia</h1>
            <p className="chat-view__subtitle">
              One model. One conversation. Nothing leaves this machine.
            </p>
            <p className="chat-view__session-note">
              This conversation exists for this session only.
            </p>
            <div className="chat-view__starters" aria-label="Starter prompts">
              {STARTER_PROMPTS.map((prompt) => (
                <Button
                  className="chat-view__starter"
                  key={prompt}
                  onClick={() => onSend(prompt)}
                  variant="lysOutline"
                >
                  <span>{prompt}</span>
                  <ArrowRight aria-hidden="true" />
                </Button>
              ))}
            </div>
          </div>
        ) : (
          <div className="chat-view__transcript">
            {messages.map((message) => {
              if (message.role === "user") {
                return (
                  <article className="chat-view__message" key={message.id}>
                    <p className="chat-view__speaker">you</p>
                    <p className="chat-view__user-copy">{message.text}</p>
                  </article>
                )
              }

              if (message.role === "error") {
                return (
                  <Alert
                    aria-live="polite"
                    className="chat-view__error"
                    key={message.id}
                    role="status"
                    variant="destructive"
                  >
                    <AlertTitle>{message.title}</AlertTitle>
                    <AlertDescription>{message.text}</AlertDescription>
                    <Button
                      className="chat-view__retry"
                      onClick={onRetry}
                      size="lysCompact"
                      variant="lysDanger"
                    >
                      Retry
                    </Button>
                  </Alert>
                )
              }

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
                        variant="lysMeta"
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
                    <p
                      aria-live="polite"
                      className="chat-view__stopped"
                      role="status"
                    >
                      Stopped
                    </p>
                  )}
                </article>
              )
            })}
          </div>
        )}
      </div>

      {!atBottom && (
        <Button
          className="chat-view__jump"
          onClick={jumpToLatest}
          size="lysCompact"
          variant="lysOutline"
        >
          <ArrowDown aria-hidden="true" />
          Jump to latest
        </Button>
      )}

      {streaming && <span className="sr-only">Lys is generating a reply</span>}
    </section>
  )
}
