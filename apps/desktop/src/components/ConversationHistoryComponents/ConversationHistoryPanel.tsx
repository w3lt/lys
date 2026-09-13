import { MAXIMUM_CONVERSATION_TITLE_LENGTH } from "@lys/protocol"
import { useEffect, useId, useRef, useState } from "react"
import type { FocusEvent, KeyboardEvent, ReactElement, RefObject } from "react"

import { type ChatViewStore, useChatViewStore } from "@/lib/store/chat-view"
import {
  type ConversationHistoryListState,
  useConversationHistoryStore
} from "@/lib/store/conversation-history"

import ConversationHistoryBrowser from "./ConversationHistoryBrowser"
import ConversationHistoryFooter from "./ConversationHistoryFooter"
import {
  type ConversationRowInteraction,
  formatConversationHistoryHint,
  NO_ROW_INTERACTION
} from "./conversation-history-presentation"

import "./ConversationHistoryPanel.scss"

/** Properties accepted by {@link ConversationHistoryPanel}. */
export type ConversationHistoryPanelProps = {
  /** Epoch milliseconds, sampled when history opened, that times relate to. */
  readonly referenceTimeMs: number
  /** Requests that the parent open a conversation and close history. */
  readonly onOpenConversation: (conversationId: string) => void
  /** Requests that the parent start a new conversation and close history. */
  readonly onStartConversation: () => void
}

/**
 * Gets the conversation the chat view presents or is opening.
 *
 * @param state - Current chat-view state.
 * @returns The opening conversation's identity, otherwise the shown one's.
 */
function getPresentedConversationId(state: ChatViewStore): string | undefined {
  return state.conversationOpen.status === "opening"
    ? state.conversationOpen.conversationId
    : state.conversation?.id
}

/**
 * Reports whether a row interaction still targets a displayed entry.
 *
 * @param list - Current list state.
 * @param rowInteraction - Interaction recorded by the panel.
 * @returns Whether no interaction is active or its row is still displayed.
 */
function isRowInteractionDisplayed(
  list: ConversationHistoryListState,
  rowInteraction: ConversationRowInteraction
): boolean {
  if (rowInteraction.kind === "none") return true
  if (list.status !== "loaded") return false

  return list.page.entries.some(
    (entry) => entry.id === rowInteraction.conversationId
  )
}

/**
 * Moves focus into history when it opens and back to its invoker when it
 * leaves without focus elsewhere.
 *
 * @param searchFieldRef - Search input that receives focus on opening.
 * @remarks The invoker is the element focused before the panel took focus. It
 * is retained across renderer effect replays, so a replay never mistakes the
 * search input for the invoker. On removal, focus is restored only when it
 * would otherwise fall to the document body and the invoker is still
 * connected; focus the user or parent moved elsewhere is left alone.
 */
function useConversationHistoryFocus(
  searchFieldRef: RefObject<HTMLInputElement | null>
): void {
  const invokerRef = useRef<Element | null>(null)

  useEffect(() => {
    const focusedElement = document.activeElement
    if (focusedElement !== searchFieldRef.current) {
      invokerRef.current = focusedElement
    }
    searchFieldRef.current?.focus()

    return () => {
      const invoker = invokerRef.current
      const isFocusLost =
        document.activeElement === null ||
        document.activeElement === document.body
      if (
        isFocusLost &&
        invoker instanceof HTMLElement &&
        invoker.isConnected
      ) {
        invoker.focus()
      }
    }
  }, [searchFieldRef])
}

/**
 * Dismisses history when a pointer press lands outside the panel.
 *
 * @param panelRef - Panel host that presses may land inside.
 * @param onDismiss - Closes history; called once per outside press.
 * @remarks The document listener belongs to this panel instance and is removed
 * on unmount or when either input changes.
 */
function useOutsidePointerDismissal(
  panelRef: RefObject<HTMLElement | null>,
  onDismiss: () => void
): void {
  useEffect(() => {
    /**
     * Dismisses history when the press target is outside the panel.
     *
     * @param event - Pointer press observed on the document.
     */
    function handleDocumentPointerDown(event: PointerEvent): void {
      const panel = panelRef.current
      if (panel === null || !(event.target instanceof Node)) return
      if (panel.contains(event.target)) return

      onDismiss()
    }

    document.addEventListener("pointerdown", handleDocumentPointerDown)
    return () =>
      document.removeEventListener("pointerdown", handleDocumentPointerDown)
  }, [panelRef, onDismiss])
}

/**
 * Presents past conversations for searching, opening, renaming, and deleting.
 *
 * @remarks Primary category: composition/view. The history store owns the
 * query, list, pending changes, and their requests; the chat-view store owns
 * which conversation is presented; the parent owns opening a conversation,
 * starting one, and closing history around those actions. The panel owns only
 * the row interaction and its focus lifecycle. It is a non-modal dialog named
 * Past conversations: on mount focus moves to the search field, and Escape,
 * a pointer press outside, or focus moving to an element outside closes it.
 * Focus returns to the invoker when closing would otherwise lose it. The
 * footer hint follows the active row interaction, which is dropped when its
 * row is no longer displayed. Rendering it presumes history is open.
 * @param props - Reference time and the parent-owned conversation actions.
 * @returns The history dialog.
 */
export default function ConversationHistoryPanel({
  referenceTimeMs,
  onOpenConversation,
  onStartConversation
}: ConversationHistoryPanelProps): ReactElement {
  const query = useConversationHistoryStore((state) => state.query)
  const list = useConversationHistoryStore((state) => state.list)
  const pendingMutations = useConversationHistoryStore(
    (state) => state.pendingMutations
  )
  const mutationError = useConversationHistoryStore(
    (state) => state.mutationError
  )
  const updateConversationHistoryQuery = useConversationHistoryStore(
    (state) => state.updateConversationHistoryQuery
  )
  const closeConversationHistory = useConversationHistoryStore(
    (state) => state.closeConversationHistory
  )
  const loadConversationHistory = useConversationHistoryStore(
    (state) => state.loadConversationHistory
  )
  const loadOlderConversations = useConversationHistoryStore(
    (state) => state.loadOlderConversations
  )
  const updateConversationTitle = useConversationHistoryStore(
    (state) => state.updateConversationTitle
  )
  const deleteConversation = useConversationHistoryStore(
    (state) => state.deleteConversation
  )
  const openConversationId = useChatViewStore(getPresentedConversationId)

  const [rowInteraction, setRowInteraction] =
    useState<ConversationRowInteraction>(NO_ROW_INTERACTION)
  const panelRef = useRef<HTMLElement>(null)
  const searchFieldRef = useRef<HTMLInputElement>(null)
  const hintId = useId()
  useConversationHistoryFocus(searchFieldRef)
  useOutsidePointerDismissal(panelRef, closeConversationHistory)

  const activeRowInteraction = isRowInteractionDisplayed(list, rowInteraction)
    ? rowInteraction
    : NO_ROW_INTERACTION

  /**
   * Replaces the row interaction; starting one on a row ends any other.
   *
   * @param nextInteraction - Complete interaction proposed by the browser.
   */
  function handleRowInteractionChange(
    nextInteraction: ConversationRowInteraction
  ): void {
    setRowInteraction(nextInteraction)
  }

  /**
   * Closes history when Escape reaches the panel unconsumed.
   *
   * @param event - Key press bubbling from within the panel.
   */
  function handlePanelKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key !== "Escape") return

    event.preventDefault()
    closeConversationHistory()
  }

  /**
   * Closes history when focus moves to an element outside the panel.
   *
   * @param event - Focus leaving an element within the panel.
   */
  function handlePanelBlur(event: FocusEvent<HTMLElement>): void {
    const nextTarget = event.relatedTarget
    if (!(nextTarget instanceof Node)) return
    if (event.currentTarget.contains(nextTarget)) return

    closeConversationHistory()
  }

  return (
    <section
      aria-label="Past conversations"
      className="conversation-history"
      onBlur={handlePanelBlur}
      onKeyDown={handlePanelKeyDown}
      ref={panelRef}
      role="dialog"
      tabIndex={-1}
    >
      <ConversationHistoryBrowser
        hintId={hintId}
        list={list}
        onCloseConversationHistory={closeConversationHistory}
        onDeleteConversation={(conversationId) =>
          void deleteConversation(conversationId)
        }
        onLoadOlderConversations={() => void loadOlderConversations()}
        onOpenConversation={onOpenConversation}
        onQueryChange={updateConversationHistoryQuery}
        onRetryConversationHistory={() => void loadConversationHistory()}
        onRowInteractionChange={handleRowInteractionChange}
        onUpdateConversationTitle={(conversationId, title) =>
          void updateConversationTitle(conversationId, title)
        }
        openConversationId={openConversationId}
        pendingMutations={pendingMutations}
        query={query}
        referenceTimeMs={referenceTimeMs}
        rowInteraction={activeRowInteraction}
        searchFieldRef={searchFieldRef}
      />
      <ConversationHistoryFooter
        hint={formatConversationHistoryHint(
          list,
          activeRowInteraction,
          MAXIMUM_CONVERSATION_TITLE_LENGTH
        )}
        hintId={hintId}
        mutationError={mutationError}
        onStartConversation={onStartConversation}
      />
    </section>
  )
}
