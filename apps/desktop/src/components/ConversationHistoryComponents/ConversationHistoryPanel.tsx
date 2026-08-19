import { useEffect } from "react"
import type { ReactElement } from "react"

import { ModalDialog } from "@/components/ModalDialog"
import { useConversationHistoryStore } from "@/lib/store/conversation-history"

import "./ConversationHistoryPanel.scss"
import { ConversationHistoryContent } from "./ConversationHistoryContent"

/** Accessible name of the conversation history dialog. */
const HISTORY_DIALOG_LABEL = "Recall conversations"

/**
 * Reports whether a keyboard event requests the history shortcut.
 *
 * @param event - Keyboard event observed on the document.
 * @returns Whether the reader pressed the platform history shortcut.
 */
function isHistoryShortcut(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k"
}

/**
 * Presents the conversation history as a modal dialog over the application.
 *
 * @remarks Primary category: composition/view. The conversation history store
 * owns whether the panel is presented; this component owns no state of its own.
 * It registers the `Ctrl`/`Cmd`+`K` shortcut on the document for as long as it
 * is mounted and removes it on unmount. The dialog owns focus containment,
 * `Escape`, background inertness, and focus restoration, and it mounts the
 * history content only while presented, so an open rename editor or delete
 * confirmation ends when the panel closes.
 * @returns The history dialog, which renders nothing while it is hidden.
 */
export function ConversationHistoryPanel(): ReactElement {
  const isPanelOpen = useConversationHistoryStore((state) => state.isPanelOpen)
  const closeHistoryPanel = useConversationHistoryStore(
    (state) => state.closeHistoryPanel
  )

  useEffect(() => {
    /**
     * Presents or hides the panel when the reader presses the shortcut.
     *
     * @param event - Keyboard event observed on the document.
     */
    function handleDocumentKeyDown(event: KeyboardEvent): void {
      if (!isHistoryShortcut(event)) return

      event.preventDefault()
      const historyStore = useConversationHistoryStore.getState()
      if (historyStore.isPanelOpen) historyStore.closeHistoryPanel()
      else historyStore.openHistoryPanel()
    }

    document.addEventListener("keydown", handleDocumentKeyDown)

    return () => {
      document.removeEventListener("keydown", handleDocumentKeyDown)
    }
  }, [])

  return (
    <ModalDialog
      className="conversation-history"
      isOpen={isPanelOpen}
      label={HISTORY_DIALOG_LABEL}
      onClose={closeHistoryPanel}
    >
      <ConversationHistoryContent />
    </ModalDialog>
  )
}
