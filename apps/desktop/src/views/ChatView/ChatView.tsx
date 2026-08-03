import type { ConversationMessage } from "@lys/share"
import { lazy, useEffect, useRef } from "react"
import type { ReactElement } from "react"
import { ArrowDown } from "lucide-react"

import { Button } from "@/components/ui/button"

import "./ChatView.scss"
import { Composer } from "@/components/Composer"
import { type ChatRequestState, useChatViewStore } from "@/lib/store/chat-view"

const StarterView = lazy(
  () => import("@/components/ChatViewComponents/StarterView")
)
const ConversationContent = lazy(
  () => import("@/components/ChatViewComponents/ConversationContent")
)

/** Immutable empty transcript used before a conversation has started. */
const EMPTY_CONVERSATION_MESSAGES: readonly ConversationMessage[] =
  Object.freeze([])

/** Properties accepted by {@link ChatView}. */
export type ChatViewProps = {
  /** Whether the transcript currently remains pinned to its latest content. */
  readonly atBottom: boolean
  /** Records whether the reader has scrolled to the latest transcript content. */
  readonly onScrollPositionChange: (atBottom: boolean) => void
}

/**
 * Determines whether a request is still waiting for or streaming a reply.
 *
 * @param request - Authoritative chat request lifecycle selected from the store.
 * @returns Whether generation remains pending from the user's perspective.
 */
function isChatReplyPending(request: ChatRequestState): boolean {
  switch (request.status) {
    case "idle":
    case "reply-completed":
      return false
    case "awaiting-user-message":
    case "awaiting-assistant-message":
    case "awaiting-start":
    case "reply-streaming":
      return true
  }
}

/**
 * Presents the conversation transcript, lifecycle feedback, and composer.
 *
 * @remarks Primary category: composition/view. The application chat-view store
 * owns conversation and request state; the surrounding shell owns whether the
 * transcript is pinned to its latest content. The component synchronizes its
 * private transcript host with that scroll contract and politely announces
 * pending reply generation.
 * @param props - Parent-owned transcript position and its change notification.
 * @returns The conversation workspace in its empty, active, or failed state.
 */
export default function ChatView({
  atBottom,
  onScrollPositionChange
}: ChatViewProps): ReactElement {
  const conversation = useChatViewStore((state) => state.conversation)
  const error = useChatViewStore((state) => state.error)
  const request = useChatViewStore((state) => state.request)
  const sendMessage = useChatViewStore((state) => state.sendMessage)
  const stopStreaming = useChatViewStore((state) => state.stopStreaming)
  const messages = conversation?.messages ?? EMPTY_CONVERSATION_MESSAGES
  const transcriptRef = useRef<HTMLDivElement>(null)
  const isReplyPending = isChatReplyPending(request)

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

        <span aria-live="polite" className="sr-only" role="status">
          {isReplyPending ? "Lys is generating a reply" : ""}
        </span>
      </section>

      <Composer messageCount={messages.length} />
    </main>
  )
}
