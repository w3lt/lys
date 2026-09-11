import { useRef, useState } from "react"
import type {
  ChangeEvent,
  ClipboardEvent,
  DragEvent,
  KeyboardEvent,
  ReactElement
} from "react"
import { Menu, Plus, Settings } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { useLysStore } from "@/lib/store"
import { useChatViewStore } from "@/lib/store/chat-view"

import ComposerAttachmentTray from "./ComposerComponents/ComposerAttachmentTray"
import ComposerContextMeter from "./ComposerComponents/ComposerContextMeter"
import ComposerModelMenu from "./ComposerComponents/ComposerModelMenu"
import ComposerOfflineBanner from "./ComposerComponents/ComposerOfflineBanner"
import ComposerPlusMenu from "./ComposerComponents/ComposerPlusMenu"
import {
  PASTED_TEXT_ATTACHMENT_THRESHOLD,
  removeComposerAttachment,
  stageComposerFiles,
  stagePastedText
} from "./ComposerComponents/composer-attachments"
import {
  type ComposerAttachment,
  calculateContextUsage,
  type ContextTurn
} from "./ComposerComponents/composer-context"
import {
  formatComposerModelLabel,
  formatComposerPlaceholder,
  formatReconnectAction,
  formatUnavailableRuntimeMessage,
  readLocalRuntimeConnection
} from "./ComposerComponents/composer-presentation"

import "./Composer.scss"

/** Empty tray used as the initial value and while nothing is staged. */
const NO_ATTACHMENTS: readonly ComposerAttachment[] = Object.freeze([])

/**
 * Selects the largest staged attachment.
 *
 * @param attachments - Files staged for the next message.
 * @returns The costliest attachment, or `undefined` when the tray is empty.
 */
function findLargestAttachment(
  attachments: readonly ComposerAttachment[]
): ComposerAttachment | undefined {
  return attachments.reduce<ComposerAttachment | undefined>(
    (largest, attachment) =>
      !largest || attachment.estimatedTokens > largest.estimatedTokens
        ? attachment
        : largest,
    undefined
  )
}

/**
 * Presents the chat draft editor, its context tray, and the session controls.
 *
 * @remarks Primary category: composition/view. The application store owns
 * runtime availability and persisted settings; the chat-view store owns the
 * draft, the conversation, and the request lifecycle. This component owns only
 * transient composer state: the staged attachment tray, whether a drag is over
 * the field, and whether the field has focus. Enter without Shift submits once
 * and suppresses the newline; Shift+Enter keeps it. Sending requires a
 * non-empty draft, and is refused while a reply is pending, while generation is
 * unavailable, or while the estimated request exceeds the window.
 *
 * Three affordances are staged ahead of the capability behind them and are
 * deliberately inert: attachments are held in the renderer and never sent
 * because the chat protocol carries no attachment field; past conversations
 * have no backing list; and selecting weights updates settings in memory only,
 * since this view does not persist them. Context figures are client-side
 * estimates throughout, marked `~` wherever they appear.
 *
 * @returns The rendered conversation composer.
 */
export function Composer(): ReactElement {
  const backendServerInfo = useLysStore((state) => state.backendServerInfo)
  const modelRuntime = useLysStore((state) => state.modelRuntime)
  const settings = useLysStore((state) => state.settings)
  const setActiveView = useLysStore((state) => state.setActiveView)
  const setSettingsPane = useLysStore((state) => state.setSettingsPane)
  const setSettings = useLysStore((state) => state.setSettings)
  const startBackend = useLysStore((state) => state.startBackend)

  const conversation = useChatViewStore((state) => state.conversation)
  const inputDraft = useChatViewStore((state) => state.inputDraft)
  const request = useChatViewStore((state) => state.request)
  const resetConversation = useChatViewStore((state) => state.resetConversation)
  const sendMessage = useChatViewStore((state) => state.sendMessage)
  const setInputDraft = useChatViewStore((state) => state.setInputDraft)

  const [attachments, setAttachments] =
    useState<readonly ComposerAttachment[]>(NO_ATTACHMENTS)
  const [isDropping, setIsDropping] = useState(false)
  const [isFocused, setIsFocused] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const backendStatus = backendServerInfo.status
  const isModelLoaded = modelRuntime.status === "loaded"
  const connection = readLocalRuntimeConnection(backendStatus, isModelLoaded)
  const isUnavailable = connection !== "ready"
  const isReplyPending = request.status !== "idle"

  const turns: readonly ContextTurn[] = (conversation?.messages ?? []).map(
    (message) => ({ id: message.id, text: message.content })
  )
  const contextUsage = calculateContextUsage({
    budget: settings.model.contextSize,
    reserve: settings.generation.replyCeiling,
    turns,
    attachments
  })
  const largestAttachment = findLargestAttachment(attachments)
  const isOverWindow = contextUsage.overflowTokens > 0

  const isSendDisabled =
    isReplyPending ||
    isUnavailable ||
    inputDraft.trim().length === 0 ||
    isOverWindow

  /**
   * Sends the current draft when Enter is pressed without a Shift modifier.
   *
   * @param event - Keyboard event emitted by the composer textarea.
   */
  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== "Enter" || event.shiftKey) return

    event.preventDefault()
    if (isSendDisabled) return
    void sendMessage()
  }

  /**
   * Diverts a long paste into the context tray instead of the draft.
   *
   * @param event - Paste event emitted by the composer textarea.
   */
  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    const pastedText = event.clipboardData.getData("text/plain")
    if (pastedText.length < PASTED_TEXT_ATTACHMENT_THRESHOLD) return

    event.preventDefault()
    setAttachments((staged) => stagePastedText(staged, pastedText))
  }

  /**
   * Stages files chosen through the hidden file input.
   *
   * @param event - Change event emitted by the file input.
   */
  function handleFilesChosen(event: ChangeEvent<HTMLInputElement>): void {
    setAttachments((staged) =>
      stageComposerFiles(staged, Array.from(event.currentTarget.files ?? []))
    )
    event.currentTarget.value = ""
  }

  /**
   * Marks the field as an active drop target.
   *
   * @param event - Drag event observed over the composer field.
   */
  function handleDragOver(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault()
    if (isUnavailable || isDropping) return

    setIsDropping(true)
  }

  /**
   * Clears the drop target once the pointer leaves the field entirely.
   *
   * @param event - Drag event observed leaving the composer field.
   */
  function handleDragLeave(event: DragEvent<HTMLDivElement>): void {
    const nextTarget = event.relatedTarget
    if (
      nextTarget instanceof Node &&
      event.currentTarget.contains(nextTarget)
    ) {
      return
    }

    setIsDropping(false)
  }

  /**
   * Stages files released over the composer field.
   *
   * @param event - Drop event carrying the released files.
   */
  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault()
    setIsDropping(false)
    if (isUnavailable) return

    setAttachments((staged) =>
      stageComposerFiles(staged, Array.from(event.dataTransfer.files))
    )
  }

  /**
   * Records the chosen weights in memory without persisting them.
   *
   * @param modelKey - Model identifier chosen from the weights menu.
   * @remarks The application store explicitly does not write settings, so this
   * selection is lost on restart until the settings save boundary is wired.
   */
  function handleSelectModel(modelKey: string): void {
    setSettings({
      ...settings,
      runtime: { ...settings.runtime, defaultModel: modelKey }
    })
  }

  /**
   * Opens past conversations.
   *
   * @remarks Not implemented. No conversation list exists on the backend, so
   * this control is present for layout only and performs no action.
   */
  function handleToggleHistory(): void {
    // Intentionally empty until a conversation-list endpoint exists.
  }

  /** Starts the backend or opens Model settings to recover model availability. */
  function handleReconnect(): void {
    if (backendStatus === "stopped") {
      void startBackend()
      return
    }

    // The Model pane owns inventory refresh, loading, and health checks.
    setSettingsPane("model")
    setActiveView("settings")
  }

  /** Opens the settings pane that owns the context-window size. */
  function handleChangeWindow(): void {
    setSettingsPane("model")
    setActiveView("settings")
  }

  return (
    <footer className="composer">
      {isUnavailable ? (
        <ComposerOfflineBanner
          action={formatReconnectAction(backendStatus, modelRuntime)}
          message={formatUnavailableRuntimeMessage(
            backendStatus,
            settings.runtime.backendAddress,
            modelRuntime
          )}
          onReconnect={handleReconnect}
        />
      ) : null}

      <div className="composer__inner">
        <div
          className="composer__field"
          data-dropping={isDropping && !isUnavailable ? "" : undefined}
          data-focused={isFocused ? "" : undefined}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          {attachments.length > 0 ? (
            <ComposerAttachmentTray
              attachments={attachments}
              onRemove={(attachmentId) =>
                setAttachments((staged) =>
                  removeComposerAttachment(staged, attachmentId)
                )
              }
              overflowingAttachmentId={
                isOverWindow ? largestAttachment?.id : undefined
              }
            />
          ) : null}

          <div className="composer__row">
            <input
              className="composer__file-input"
              multiple
              onChange={handleFilesChosen}
              ref={fileInputRef}
              type="file"
            />

            <ComposerPlusMenu
              disabled={isUnavailable}
              hasAttachments={attachments.length > 0}
              onAttachFile={() => fileInputRef.current?.click()}
            />

            <Textarea
              aria-label="Message Lys"
              className="composer__textarea"
              disabled={isUnavailable}
              onBlur={() => setIsFocused(false)}
              onChange={(event) => setInputDraft(event.currentTarget.value)}
              onFocus={() => setIsFocused(true)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={formatComposerPlaceholder(
                connection,
                isReplyPending
              )}
              rows={1}
              value={inputDraft}
            />

            <Button
              className="composer__send"
              disabled={isSendDisabled}
              onClick={() => void sendMessage()}
              type="button"
            >
              Send
            </Button>
          </div>

          {isDropping && !isUnavailable ? (
            <span aria-hidden="true" className="composer__drop">
              release to add to context
            </span>
          ) : null}
        </div>

        <div className="composer__meta">
          <div className="composer__actions">
            <button
              className="composer__icon-button"
              onClick={resetConversation}
              title="New conversation"
              type="button"
            >
              <Plus aria-hidden="true" />
              <span className="sr-only">New conversation</span>
            </button>

            <button
              className="composer__icon-button"
              onClick={handleToggleHistory}
              title="Past conversations"
              type="button"
            >
              <Menu aria-hidden="true" />
              <span className="sr-only">Past conversations</span>
            </button>

            <button
              className="composer__icon-button"
              onClick={() => setActiveView("settings")}
              title="Settings"
              type="button"
            >
              <Settings aria-hidden="true" />
              <span className="sr-only">Settings</span>
            </button>

            <span aria-hidden="true" className="composer__divider" />

            <ComposerModelMenu
              label={formatComposerModelLabel(
                backendStatus,
                modelRuntime,
                settings.runtime.defaultModel
              )}
              modelRuntime={modelRuntime}
              onSelectModel={handleSelectModel}
              selectedModelKey={settings.runtime.defaultModel}
            />
          </div>

          <div className="composer__meta-right">
            {isReplyPending ? (
              <span className="composer__generating">Generating…</span>
            ) : null}

            {!isUnavailable ? (
              <ComposerContextMeter
                attachments={attachments}
                largestAttachment={largestAttachment}
                onChangeWindow={handleChangeWindow}
                usage={contextUsage}
              />
            ) : null}
          </div>
        </div>
      </div>
    </footer>
  )
}
