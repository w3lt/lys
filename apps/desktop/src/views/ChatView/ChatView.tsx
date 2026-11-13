import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState
} from "react"
import type { ReactElement, RefObject } from "react"

import "./ChatView.scss"
import ConversationHistoryPanel from "@/components/ConversationHistoryComponents/ConversationHistoryPanel"
import { Composer } from "@/components/Composer"
import { type BackendServerStatus, useLysStore } from "@/lib/store"
import { useAgentStore } from "@/lib/store/agents"
import { useChatViewStore } from "@/lib/store/chat-view"
import { useConversationHistoryStore } from "@/lib/store/conversation-history"

import ShownConversationPanel from "./ShownConversationPanel"

/** Properties accepted by {@link ChatView}. */
export type ChatViewProps = {
  /** Whether the parent-owned transcript currently remains pinned to latest content. */
  readonly atBottom: boolean
  /**
   * Receives native-scroll near-bottom results and jump activation state.
   *
   * @remarks Native scroll events report the measured position. Activating
   * “Jump to latest”, opening a past conversation or a job, and starting one
   * from history report `true` immediately, before any scroll has completed.
   * The view hands a callback built on this one to every message of the
   * transcript, so a stable identity spares their renders.
   */
  readonly onScrollPositionChange: (atBottom: boolean) => void
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
 * @remarks The history store owns whether history is open, and the press
 * opens or closes it there. The document listener belongs to the chat view
 * and is replaced whenever history opens or closes, so a press always acts
 * on the current state. Repeated presses from a held key and presses during
 * text composition are ignored. The shortcut's default action is prevented.
 */
function useConversationHistoryShortcut(): void {
  const isHistoryOpen = useConversationHistoryStore(
    (state) => state.visibility.status === "open"
  )
  const openConversationHistory = useConversationHistoryStore(
    (state) => state.openConversationHistory
  )
  const closeConversationHistory = useConversationHistoryStore(
    (state) => state.closeConversationHistory
  )

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
      if (isHistoryOpen) closeConversationHistory()
      else openConversationHistory()
    }

    document.addEventListener("keydown", handleDocumentKeyDown)
    return () => document.removeEventListener("keydown", handleDocumentKeyDown)
  }, [isHistoryOpen, openConversationHistory, closeConversationHistory])
}

/**
 * Owns the host of the composer's message field and moves focus to it once a
 * conversation the person started is shown.
 *
 * @param startedConversationCount - Reactive count of the conversations the
 * person started from the chat view; each new value is one start the view
 * recorded.
 * @returns The message field host for the caller to attach. The ref keeps its
 * identity for the view's lifetime, and React sets it while the field is
 * rendered.
 * @remarks Focus moves in the layout phase of the commit that shows a started
 * conversation, not when the start is requested: a conversation whose agent
 * was deleted disables the field, which can take focus only once the new
 * conversation is committed. A field that is still disabled then, as while
 * generation is unavailable, or that is not attached, takes no focus. The
 * first render moves no focus.
 */
function useMessageFieldFocus(
  startedConversationCount: number
): RefObject<HTMLTextAreaElement | null> {
  const messageFieldRef = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    if (startedConversationCount > 0) messageFieldRef.current?.focus()
  }, [startedConversationCount])

  return messageFieldRef
}

/**
 * Reads the agent list when the chat view appears and whenever the backend
 * starts running.
 *
 * @remarks The agent store owns the list and its reads; the hook only asks
 * for one while the backend runs, and leaving the view cancels nothing. A
 * list read while the backend ran stays shown after it stops.
 */
function useAgentListRead(): void {
  const backendStatus = useLysStore((state) => state.backendServerInfo.status)
  const loadAgents = useAgentStore((state) => state.loadAgents)

  /**
   * Handles a change of the backend's status, by reading the agent list once
   * the backend runs.
   *
   * @param status - The backend's status after the change.
   */
  function handleBackendStatusChange(status: BackendServerStatus): void {
    if (status === "running") void loadAgents()
  }
  const handleBackendStatus = useEffectEvent(handleBackendStatusChange)

  useEffect(() => {
    handleBackendStatus(backendStatus)
  }, [backendStatus])
}

/**
 * Presents the shown conversation, past conversations, and the composer.
 *
 * @remarks The shown conversation's panel owns its transcript, the cards of
 * its jobs, its pending-work announcement, and its scroll position; the
 * chat-view store owns opening and starting conversations; the history store
 * owns whether past conversations are shown; the surrounding shell owns
 * whether the transcript is pinned to its latest content. The agent store
 * owns the agent list, which the view reads when it appears and whenever the
 * backend starts running, so the transcript and the composer can name the
 * agent that answers and tell when it was deleted; leaving the view cancels
 * nothing. The component owns the message-field ref and the count of
 * conversations the person started from it; request cancellation is owned
 * by the composer, which stays mounted in every request phase. Command+K or
 * Control+K toggles past conversations, which then dim the workspace behind
 * a dialog docked above the composer. Opening a conversation from that
 * dialog, or a job from its card, closes the dialog, pins the transcript to
 * its latest content, and moves focus to the message field; the open itself
 * continues in the store. The open callback keeps its identity while
 * `onScrollPositionChange` keeps its own, so the transcript's messages are
 * not rendered again for a new one. Starting a conversation, from that
 * dialog or from the composer's deleted-agent notice, closes the dialog,
 * pins the transcript, and moves focus to the message field once the new
 * conversation is shown, when the field can take it. The history dialog is
 * loaded eagerly because it is small and opening it must not wait on a
 * module load.
 * @param props - Parent-owned transcript position and its change notification.
 * @returns The conversation workspace in its empty, active, or failed state.
 */
export default function ChatView({
  atBottom,
  onScrollPositionChange
}: ChatViewProps): ReactElement {
  const openConversation = useChatViewStore((state) => state.openConversation)
  const resetConversation = useChatViewStore((state) => state.resetConversation)
  const historyVisibility = useConversationHistoryStore(
    (state) => state.visibility
  )
  const closeConversationHistory = useConversationHistoryStore(
    (state) => state.closeConversationHistory
  )
  const [startedConversationCount, setStartedConversationCount] = useState(0)
  const messageFieldRef = useMessageFieldFocus(startedConversationCount)
  useConversationHistoryShortcut()
  useAgentListRead()

  /**
   * Closes history and opens one conversation for reading and replying: a
   * past conversation chosen in history, or a job chosen on its card.
   */
  const handleOpenConversation = useCallback(
    (conversationId: string): void => {
      closeConversationHistory()
      onScrollPositionChange(true)
      messageFieldRef.current?.focus()
      void openConversation(conversationId)
    },
    [
      closeConversationHistory,
      messageFieldRef,
      onScrollPositionChange,
      openConversation
    ]
  )

  /**
   * Closes history, starts a new, empty conversation, and records the start,
   * which moves focus to the message field once the conversation is shown.
   */
  function handleStartConversation(): void {
    closeConversationHistory()
    resetConversation()
    onScrollPositionChange(true)
    setStartedConversationCount((count) => count + 1)
  }

  return (
    <main className="app-shell__chat">
      <ShownConversationPanel
        atBottom={atBottom}
        onOpenJob={handleOpenConversation}
        onScrollPositionChange={onScrollPositionChange}
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
      <Composer
        messageFieldRef={messageFieldRef}
        onStartConversation={handleStartConversation}
      />
    </main>
  )
}
