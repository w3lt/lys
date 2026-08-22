import { useState } from "react"
import type { ReactElement } from "react"

import { Button } from "@/components/ui/button"
import { useLysStore } from "@/lib/store"
import { useChatViewStore } from "@/lib/store/chat-view"
import {
  findLoadedConversationPage,
  useConversationHistoryStore
} from "@/lib/store/conversation-history"

import { formatConversationHistoryCount } from "./conversation-history-presentation"
import { ConversationHistoryBody } from "./ConversationHistoryBody"
import type { ConversationRowInteraction } from "./ConversationHistoryList"
import type { ConversationRowActions } from "./ConversationHistoryRow"
import { ConversationSearchField } from "./ConversationSearchField"

/** Row interaction presented when no row is being renamed or deleted. */
const IDLE_ROW_INTERACTION: ConversationRowInteraction = Object.freeze({
  status: "idle"
})

/**
 * Presents the conversation history search, list, and row actions.
 *
 * @remarks Primary category: composition/view. The conversation history store
 * owns the search text, the loaded conversations, and every conversation
 * operation; the chat-view store owns which conversation is active. This
 * component owns only the single row-level interaction — the open rename
 * editor or delete confirmation — and abandons it whenever the search text
 * changes or an operation succeeds. Its parent mounts it only while the
 * history dialog is presented, so that interaction ends when the dialog closes.
 * @returns The history header, list region, and footer.
 */
export function ConversationHistoryContent(): ReactElement {
  const searchQuery = useConversationHistoryStore((state) => state.searchQuery)
  const list = useConversationHistoryStore((state) => state.list)
  const operation = useConversationHistoryStore((state) => state.operation)
  const closeHistoryPanel = useConversationHistoryStore(
    (state) => state.closeHistoryPanel
  )
  const setSearchQuery = useConversationHistoryStore(
    (state) => state.setSearchQuery
  )
  const loadConversations = useConversationHistoryStore(
    (state) => state.loadConversations
  )
  const loadNextConversationPage = useConversationHistoryStore(
    (state) => state.loadNextConversationPage
  )
  const updateConversationTitle = useConversationHistoryStore(
    (state) => state.updateConversationTitle
  )
  const deleteConversation = useConversationHistoryStore(
    (state) => state.deleteConversation
  )
  const openConversation = useConversationHistoryStore(
    (state) => state.openConversation
  )
  const activeConversationId = useChatViewStore(
    (state) => state.conversation?.id
  )
  const resetConversation = useChatViewStore((state) => state.resetConversation)
  const setActiveView = useLysStore((state) => state.setActiveView)
  const [rowInteraction, setRowInteraction] =
    useState<ConversationRowInteraction>(IDLE_ROW_INTERACTION)
  const page = findLoadedConversationPage(list)

  /**
   * Replaces the search text and abandons any open row interaction.
   *
   * @param nextSearchQuery - Text currently entered in the search field.
   */
  function handleSearchQueryChange(nextSearchQuery: string): void {
    setRowInteraction(IDLE_ROW_INTERACTION)
    setSearchQuery(nextSearchQuery)
  }

  /**
   * Presents the rename editor for one conversation.
   *
   * @param conversationId - Conversation the reader chose to rename.
   */
  function handleStartConversationRename(conversationId: string): void {
    const conversation = page?.conversations.find(
      (listed) => listed.id === conversationId
    )

    setRowInteraction({
      status: "renaming",
      conversationId,
      draftTitle: conversation?.title ?? ""
    })
  }

  /**
   * Records the title entered in the open rename editor.
   *
   * @param draftTitle - Text currently entered in the rename editor.
   */
  function handleRenameDraftTitleChange(draftTitle: string): void {
    setRowInteraction((interaction) =>
      interaction.status === "renaming"
        ? { ...interaction, draftTitle }
        : interaction
    )
  }

  /**
   * Persists the title entered in the open rename editor.
   *
   * @param conversationId - Conversation being renamed.
   * @returns A promise resolving after the rename settles.
   */
  async function handleSubmitConversationRename(
    conversationId: string
  ): Promise<void> {
    if (rowInteraction.status !== "renaming") return

    const outcome = await updateConversationTitle(
      conversationId,
      rowInteraction.draftTitle
    )
    if (outcome !== "succeeded") return

    setRowInteraction(IDLE_ROW_INTERACTION)
  }

  /**
   * Permanently deletes one conversation the reader confirmed.
   *
   * @param conversationId - Conversation being removed.
   * @returns A promise resolving after the deletion settles.
   */
  async function handleDeleteConversation(
    conversationId: string
  ): Promise<void> {
    const outcome = await deleteConversation(conversationId)
    if (outcome !== "succeeded") return

    setRowInteraction(IDLE_ROW_INTERACTION)
  }

  /** Leaves the history for an empty chat in the chat view. */
  function handleStartNewConversation(): void {
    resetConversation()
    setActiveView("chat")
    closeHistoryPanel()
  }

  const rowActions: ConversationRowActions = {
    onOpenConversation: (conversationId) =>
      void openConversation(conversationId),
    onStartConversationRename: handleStartConversationRename,
    onRenameDraftTitleChange: handleRenameDraftTitleChange,
    onSubmitConversationRename: (conversationId) =>
      void handleSubmitConversationRename(conversationId),
    onRequestConversationDelete: (conversationId) =>
      setRowInteraction({ status: "confirming-delete", conversationId }),
    onDeleteConversation: (conversationId) =>
      void handleDeleteConversation(conversationId),
    onCancelConversationAction: () => setRowInteraction(IDLE_ROW_INTERACTION)
  }

  return (
    <>
      <div className="conversation-history__header">
        <span className="conversation-history__eyebrow">Recall</span>
        <ConversationSearchField
          onSearchQueryChange={handleSearchQueryChange}
          searchQuery={searchQuery}
        />
        <span className="conversation-history__count">
          {page === undefined
            ? ""
            : formatConversationHistoryCount(page, searchQuery)}
        </span>
      </div>

      <div className="conversation-history__body">
        <ConversationHistoryBody
          actions={rowActions}
          activeConversationId={activeConversationId}
          list={list}
          onLoadConversations={() => void loadConversations()}
          onLoadNextConversationPage={() => void loadNextConversationPage()}
          operation={operation}
          rowInteraction={rowInteraction}
          searchQuery={searchQuery}
        />
      </div>

      <div className="conversation-history__footer">
        {operation.status === "failed" ? (
          <p className="conversation-history__operation-error" role="alert">
            {operation.error}
          </p>
        ) : (
          <p className="conversation-history__hint">
            Tab moves · Enter opens · rename and delete sit beside each entry
          </p>
        )}
        <Button
          onClick={handleStartNewConversation}
          size="sm"
          type="button"
          variant="outline"
        >
          Start a new one
        </Button>
      </div>
    </>
  )
}
