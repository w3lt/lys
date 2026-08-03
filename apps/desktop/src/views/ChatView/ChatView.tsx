import { lazy, useEffect, useMemo, useRef } from "react"
import type { ReactElement } from "react"
import { ArrowDown } from "lucide-react"

import { Button } from "@/components/ui/button"

import "./ChatView.scss"
import { Composer } from "@/components/Composer"
import { useChatViewStore } from "@/lib/store/chat-view"

const StarterView = lazy(
  () => import("@/components/ChatViewComponents/StarterView")
)
const ConversationContent = lazy(
  () => import("@/components/ChatViewComponents/ConversationContent")
)

/** Properties accepted by {@link ChatView}. */
export type ChatViewProps = {
  /** Whether the transcript currently remains pinned to its latest content. */
  readonly atBottom: boolean
  /** Records whether the reader has scrolled to the latest transcript content. */
  readonly onScrollPositionChange: (atBottom: boolean) => void
}

/**
 * Renders the conversation transcript, lifecycle feedback, and composer.
 *
 * @param props - Scroll state owned by the surrounding application shell.
 * @returns The rendered chat workspace.
 */
export default function ChatView({
  atBottom,
  onScrollPositionChange
}: ChatViewProps): ReactElement {
  const { conversation, error, request, sendMessage, stopStreaming } =
    useChatViewStore((state) => state)
  const messages = useMemo(
    () => conversation?.messages ?? [],
    [conversation?.messages]
  )
  const transcriptRef = useRef<HTMLDivElement>(null)
  const isReplyPending =
    request.status === "awaiting-start" || request.status === "reply-streaming"

  useEffect(() => {
    const element = transcriptRef.current

    if (!element || !atBottom || messages.length === 0) return

    element.scrollTo?.({ top: element.scrollHeight })
  }, [atBottom, messages])

  /** Records whether the reader remains near the bottom of the transcript. */
  function handleScroll(): void {
    const element = transcriptRef.current
    if (!element) return

    const nearBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight < 120
    onScrollPositionChange(nearBottom)
  }

  /** Scrolls the transcript to its latest content and restores pinned state. */
  function jumpToLatest(): void {
    const element = transcriptRef.current
    if (!element) return

    element.scrollTo?.({ top: element.scrollHeight, behavior: "smooth" })
    onScrollPositionChange(true)
  }

  return (
    <main className="app-shell__chat">
      <section className="chat-view" aria-label="Conversation">
        <div
          className="chat-view__scroller"
          data-testid="transcript"
          onScroll={handleScroll}
          ref={transcriptRef}
        >
          {messages.length === 0 && !error ? (
            <StarterView onSend={(prompt) => void sendMessage(prompt)} />
          ) : (
            <ConversationContent
              error={error}
              messages={messages}
              onStop={stopStreaming}
            />
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

        {isReplyPending && (
          <span className="sr-only">Lys is generating a reply</span>
        )}
      </section>

      <Composer messageCount={messages.length} />
    </main>
  )
}
