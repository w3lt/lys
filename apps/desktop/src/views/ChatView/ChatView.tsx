import { lazy, useEffect, useRef } from "react"
import { ArrowDown } from "lucide-react"

import type { Message } from "@/app/types"
import { Button } from "@/components/ui/button"

import "./ChatView.scss"

const StarterView = lazy(
  () => import("@/components/ChatViewComponents/StarterView")
)
const ConversationContent = lazy(
  () => import("@/components/ChatViewComponents/ConversationContent")
)

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
  onSend
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
          <StarterView onSend={onSend} />
        ) : (
          <ConversationContent messages={messages} />
        )}
      </div>

      {!atBottom && (
        <Button
          className="chat-view__jump"
          onClick={jumpToLatest}
          size="sm"
          variant="outline"
        >
          <ArrowDown aria-hidden="true" />
          Jump to latest
        </Button>
      )}

      {streaming && <span className="sr-only">Lys is generating a reply</span>}
    </section>
  )
}
