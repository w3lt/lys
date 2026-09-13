import { useEffect, useRef } from "react"
import type { ReactElement } from "react"

import "./ChatView.scss"
import ConversationPanel from "@/components/ChatViewComponents/ConversationPanel"
import {
  type ConversationActivity,
  createConversationPresentation
} from "@/components/ChatViewComponents/conversation-presentation"
import ConversationHistoryPanel from "@/components/ConversationHistoryComponents/ConversationHistoryPanel"
import { Composer } from "@/components/Composer"
import {
  type ChatRequestState,
  type ConversationOpenState,
  useChatViewStore
} from "@/lib/store/chat-view"
import type { ReadonlyConversationMessage } from "@/lib/store/chat-view/conversation-transitions"
import { useConversationHistoryStore } from "@/lib/store/conversation-history"

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
   * “Jump to latest”, opening a past conversation, and starting one from
   * history report `true` immediately, before any scroll has completed.
   */
  readonly onScrollPositionChange: (atBottom: boolean) => void
}

/**
 * Determines what the conversation region is waiting on.
 *
 * @param request - Authoritative chat request lifecycle selected from the store.
 * @param conversationOpen - Authoritative stored-conversation open lifecycle.
 * @returns Opening while a stored conversation is read, generating while a
 * reply is awaited or streamed, and idle otherwise.
 */
function calculateConversationActivity(
  request: ChatRequestState,
  conversationOpen: ConversationOpenState
): ConversationActivity {
  if (conversationOpen.status === "opening") return "opening-conversation"

  switch (request.status) {
    case "idle":
    case "reply-completed":
      return "idle"
    case "awaiting-turn":
    case "reply-streaming":
      return "generating-reply"
  }
}

/**
 * Reports whether a key press is the conversation-history shortcut.
 *
 * @param event - Key press observed on the document.
 * @returns Whether it is Command+K or Control+K without Shift or Option.
 */
function isConversationHistoryShortcut(event: KeyboardEvent): boolean {
  const hasCommandModifier = event.metaKey || event.ctrlKey
  const hasExtraModifier = event.altKey || event.shiftKey

  return (
    hasCommandModifier && !hasExtraModifier && event.key.toLowerCase() === "k"
  )
}

/**
 * Toggles conversation history from the keyboard while the chat view is shown.
 *
 * @param isHistoryOpen - Whether history is currently open; read reactively.
 * @param onOpenHistory - Opens history when the shortcut is pressed while closed.
 * @param onCloseHistory - Closes history when the shortcut is pressed while open.
 * @remarks The document listener belongs to the chat view and is replaced
 * whenever an input changes, so a press always acts on the current state.
 * Repeated presses from a held key and presses during text composition are
 * ignored. The shortcut's default action is prevented.
 */
function useConversationHistoryShortcut(
  isHistoryOpen: boolean,
  onOpenHistory: () => void,
  onCloseHistory: () => void
): void {
  useEffect(() => {
    /**
     * Toggles history when the shortcut is pressed.
     *
     * @param event - Key press observed on the document.
     */
    function handleDocumentKeyDown(event: KeyboardEvent): void {
      if (event.repeat || event.isComposing) return
      if (!isConversationHistoryShortcut(event)) return

      event.preventDefault()
      if (isHistoryOpen) onCloseHistory()
      else onOpenHistory()
    }

    document.addEventListener("keydown", handleDocumentKeyDown)
    return () => document.removeEventListener("keydown", handleDocumentKeyDown)
  }, [isHistoryOpen, onOpenHistory, onCloseHistory])
}

/**
 * Presents the conversation transcript, lifecycle feedback, past
 * conversations, and composer.
 *
 * @remarks The chat-view store owns
 * conversation, request, and open state; the history store owns whether past
 * conversations are shown; the surrounding shell owns whether the transcript
 * is pinned to its latest content. The component owns the transcript host ref
 * and the message-field ref. It synchronizes the transcript's scroll position
 * only while the parent says it is pinned and messages exist, forwards starter
 * submission to the store, and politely announces a pending reply or
 * conversation open; request cancellation is owned by the composer, which
 * stays mounted in every request phase. Command+K or Control+K toggles past
 * conversations, which then dim the workspace behind a dialog docked above
 * the composer. Opening a conversation or starting one from that dialog closes
 * it, pins the transcript to its latest content, and moves focus to the
 * message field; the open itself continues in the store. The history dialog is
 * loaded eagerly because it is small and opening it must not wait on a module
 * load. The initial empty conversation is a valid state and renders through
 * the starter view rather than a loading placeholder.
 * @param props - Parent-owned transcript position and its change notification.
 * @returns The conversation workspace in its empty, active, or failed state.
 */
export default function ChatView({
  atBottom,
  onScrollPositionChange
}: ChatViewProps): ReactElement {
  const conversation = useChatViewStore((state) => state.conversation)
  const conversationOpen = useChatViewStore((state) => state.conversationOpen)
  const error = useChatViewStore((state) => state.error)
  const request = useChatViewStore((state) => state.request)
  const sendMessage = useChatViewStore((state) => state.sendMessage)
  const openConversation = useChatViewStore((state) => state.openConversation)
  const resetConversation = useChatViewStore((state) => state.resetConversation)
  const historyVisibility = useConversationHistoryStore(
    (state) => state.visibility
  )
  const openConversationHistory = useConversationHistoryStore(
    (state) => state.openConversationHistory
  )
  const closeConversationHistory = useConversationHistoryStore(
    (state) => state.closeConversationHistory
  )
  const messages = conversation?.messages ?? EMPTY_CONVERSATION_MESSAGES
  const presentation = createConversationPresentation(messages)
  const transcriptRef = useRef<HTMLDivElement>(null)
  const messageFieldRef = useRef<HTMLTextAreaElement>(null)
  const activity = calculateConversationActivity(request, conversationOpen)
  useConversationHistoryShortcut(
    historyVisibility.status === "open",
    openConversationHistory,
    closeConversationHistory
  )

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

  /**
   * Closes history and opens one past conversation for reading and replying.
   *
   * @param conversationId - Conversation chosen in history.
   */
  function handleOpenConversation(conversationId: string): void {
    closeConversationHistory()
    onScrollPositionChange(true)
    messageFieldRef.current?.focus()
    void openConversation(conversationId)
  }

  /** Closes history and starts a new, empty conversation. */
  function handleStartConversation(): void {
    closeConversationHistory()
    resetConversation()
    onScrollPositionChange(true)
    messageFieldRef.current?.focus()
  }

  return (
    <main className="app-shell__chat">
      <ConversationPanel
        {...presentation}
        activity={activity}
        error={error}
        isAtBottom={atBottom}
        onJumpToLatest={handleJumpToLatest}
        onSendMessage={sendMessage}
        onTranscriptScroll={handleTranscriptScroll}
        transcriptRef={transcriptRef}
      />
      {historyVisibility.status === "open" ? (
        <>
          <div aria-hidden="true" className="chat-view__veil" />
          <div className="chat-view__history-dock">
            <ConversationHistoryPanel
              onOpenConversation={handleOpenConversation}
              onStartConversation={handleStartConversation}
              referenceTimeMs={historyVisibility.openedAtMs}
            />
          </div>
        </>
      ) : null}
      <Composer messageFieldRef={messageFieldRef} />
    </main>
  )
}
