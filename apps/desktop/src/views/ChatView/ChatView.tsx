import { useEffect, useRef } from "react"
import type { ReactElement } from "react"

import "./ChatView.scss"
import ConversationPanel from "@/components/ChatViewComponents/ConversationPanel"
import { createConversationPresentation } from "@/components/ChatViewComponents/conversation-presentation"
import { Composer } from "@/components/Composer"
import { type ChatRequestState, useChatViewStore } from "@/lib/store/chat-view"
import type { ReadonlyConversationMessage } from "@/lib/store/chat-view/conversation-transitions"

/** Immutable empty transcript used before a conversation has started. */
const EMPTY_CONVERSATION_MESSAGES: readonly ReadonlyConversationMessage[] =
  Object.freeze([])

/** Properties accepted by {@link ChatView}. */
export type ChatViewProps = {
  /** Whether the parent-owned transcript currently remains pinned to latest content. */
  readonly atBottom: boolean
  /**
   * Receives native-scroll near-bottom results and jump activation state.
   *
   * @remarks Native scroll events report the measured position. Activating
   * “Jump to latest” reports `true` immediately, before the requested smooth
   * scroll has completed.
   */
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
    case "awaiting-turn":
    case "reply-streaming":
      return true
  }
}

/**
 * Presents the conversation transcript, lifecycle feedback, and composer.
 *
 * @remarks Primary category: composition/view. The application chat-view store
 * owns conversation and request state; the surrounding shell owns whether the
 * transcript is pinned to its latest content. The component owns the
 * transcript host ref and synchronizes its scroll position only while the
 * parent says it is pinned and messages exist. It forwards starter submission
 * and stop actions to the store, and politely announces pending generation.
 * The initial empty conversation is a valid state and renders through the
 * starter view rather than a loading placeholder.
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
  const presentation = createConversationPresentation(messages)
  const transcriptRef = useRef<HTMLDivElement>(null)
  const isReplyPending = isChatReplyPending(request)

  useEffect(() => {
    const element = transcriptRef.current

    if (!element || !atBottom || messages.length === 0) return

    element.scrollTo?.({ top: element.scrollHeight })
  }, [atBottom, messages])

  /** Records whether the reader remains near the bottom of the transcript. */
  function handleTranscriptScroll(): void {
    const element = transcriptRef.current
    if (!element) return

    const nearBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight < 120
    onScrollPositionChange(nearBottom)
  }

  /** Scrolls the transcript to its latest content and restores pinned state. */
  function handleJumpToLatest(): void {
    const element = transcriptRef.current
    if (!element) return

    element.scrollTo?.({ top: element.scrollHeight, behavior: "smooth" })
    onScrollPositionChange(true)
  }

  return (
    <main className="app-shell__chat">
      {presentation.kind === "streaming-tail" ? (
        <ConversationPanel
          completedMessages={presentation.completedMessages}
          error={error}
          isAtBottom={atBottom}
          isReplyPending={isReplyPending}
          kind={presentation.kind}
          onJumpToLatest={handleJumpToLatest}
          onSendMessage={sendMessage}
          onStopReply={stopStreaming}
          onTranscriptScroll={handleTranscriptScroll}
          streamingMessage={presentation.streamingMessage}
          transcriptRef={transcriptRef}
        />
      ) : (
        <ConversationPanel
          completedMessages={presentation.completedMessages}
          error={error}
          isAtBottom={atBottom}
          isReplyPending={isReplyPending}
          kind={presentation.kind}
          onJumpToLatest={handleJumpToLatest}
          onSendMessage={sendMessage}
          onTranscriptScroll={handleTranscriptScroll}
          transcriptRef={transcriptRef}
        />
      )}
      <Composer />
    </main>
  )
}
