import { useRef, useState } from "react"
import type {
  ChangeEvent,
  DragEvent,
  KeyboardEvent,
  ReactElement,
  RefObject
} from "react"
import { Menu, Plus, Settings } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { useAnsweringAgent } from "@/lib/hooks/answeringAgent"
import { useChatContextMeasurement } from "@/lib/hooks/chatContextMeasurement"
import { useConversationModel } from "@/lib/hooks/conversationModel"
import { useLysStore } from "@/lib/store"
import { useAgentStore } from "@/lib/store/agents"
import {
  buildAgentChoices,
  formatConversationAgentName
} from "@/lib/store/agents/conversation-agent"
import { useChatViewStore } from "@/lib/store/chat-view"
import { calculateStagedImageTokens } from "@/lib/store/chat-view/attachments"
import { useConversationHistoryStore } from "@/lib/store/conversation-history"
import { findShownToolCall, useToolCallStore } from "@/lib/store/tool-calls"

import ComposerAgentMenu from "./ComposerComponents/ComposerAgentMenu"
import ComposerAttachmentTray from "./ComposerComponents/ComposerAttachmentTray"
import ComposerContextMeter from "./ComposerComponents/ComposerContextMeter"
import ComposerDeletedAgentNotice from "./ComposerComponents/ComposerDeletedAgentNotice"
import ComposerModelMenu from "./ComposerComponents/ComposerModelMenu"
import ComposerOfflineBanner from "./ComposerComponents/ComposerOfflineBanner"
import ComposerPlusMenu from "./ComposerComponents/ComposerPlusMenu"
import ComposerToolCallPrompt from "./ComposerComponents/ComposerToolCallPrompt"
import { buildContextMeterState } from "./ComposerComponents/composer-context"
import {
  buildComposerModelState,
  calculateComposerActivity,
  calculateLocalRuntimeConnection,
  findComposerBannerAction,
  formatComposerActivity,
  formatComposerModelLabel,
  formatComposerPlaceholder,
  formatUnavailableRuntimeMessage,
  listComposerModelGroups,
  type ComposerRuntime
} from "./ComposerComponents/composer-presentation"

import "./Composer.scss"

/** Properties accepted by {@link Composer}. */
export type ComposerProps = {
  /**
   * Parent-owned ref attached to the message field.
   *
   * @remarks The parent uses it only to move focus into the field after the
   * user opens or starts a conversation.
   */
  readonly messageFieldRef: RefObject<HTMLTextAreaElement | null>
  /**
   * Requests that the parent start a new conversation and move focus to the
   * message field once that conversation is shown.
   */
  readonly onStartConversation: () => void
}

/**
 * Presents the chat draft editor, its context tray, and the session controls.
 *
 * @remarks The application store owns
 * runtime availability and persisted settings; the chat-view store owns the
 * draft, the staged attachment tray, the conversation, the request
 * lifecycle, and conversation opening; the history store owns whether past
 * conversations are shown. This component owns only transient composer
 * state: whether a drag is over the field and whether the field has focus.
 * The parent owns the
 * message-field ref. Enter without Shift submits once and suppresses the
 * newline; Shift+Enter keeps it. Sending requires a non-empty draft, and is
 * refused while a reply is awaited or streams, while a past conversation is
 * opening, while generation is unavailable, or while the current measurement
 * with the draft's estimate exceeds the loaded model's window. A request the
 * meter could not measure, or is measuring again, can still be sent; the
 * backend checks every round before sending it. The Past conversations button
 * opens history, or closes it when open, and exposes that state through
 * `aria-expanded`. The next message goes to the conversation's model — the
 * model picked in the weights menu for the shown conversation, else the
 * model of its latest reply, else the session's default, else the first
 * model that can answer — and to no other. While that model cannot answer, a
 * banner names the first missing prerequisite — the backend, the model's
 * provider, or its loaded weights — and its action starts a stopped backend
 * or opens the settings pane that fixes the problem: Runtime for the
 * backend, Providers for a provider that is off, needs a key, or is not
 * reachable, Models for inventory and loading. Without a model, while no
 * turned-on provider can answer, the banner names the first of them, in
 * provider order, and why it cannot.
 *
 * The primary control is Stop while a reply is awaited — while the
 * conversation turn is awaited and while the reply streams — and Send
 * otherwise, including after the reply completed while its stream stays open
 * for a title. Sending then stops following that stream; the backend keeps
 * generating the title. Cancellation is bound here rather than to the
 * transcript because the transcript has no assistant message to carry a
 * control while the turn is awaited. Stop delegates to the store's stop
 * action, which preserves the draft and the staged tray and owns the request's
 * completion and failure. While the reply streams, it asks the backend to stop
 * the reply and keeps applying the stream until `interrupted` or `done`
 * arrives; while the turn is awaited, the stop is remembered and sent once the
 * reply is known, unless the user moves to another conversation first. A
 * press that lands after the reply completed only stops following its stream,
 * and one after the lifecycle became idle is ignored. Repeated presses send
 * repeated stop requests, which the backend treats idempotently. Moving to
 * another conversation stops following a reply without stopping it.
 *
 * The agent menu names the agent that answers: before the first message it
 * selects the agent of the new conversation from the agent store's list, and
 * once a conversation is shown or its first reply is awaited that agent is
 * fixed. The field is named after the agent. When the shown conversation's
 * agent was deleted, the field and Send are disabled and a notice above the
 * field offers a new conversation; the conversation stays readable. The
 * notice's status line stays rendered while it is empty, and its New
 * conversation button asks the parent for the conversation, because the
 * button leaves with the notice and the parent moves focus to the field. The
 * menu's Start a new one resets the conversation in the store instead and
 * keeps the menu open, so the agent can be chosen at once.
 *
 * Above the field, the tool-call prompt shows the first tool call of the
 * shown conversation that waits for the person or whose answer failed to
 * send, else the first whose prompt expired, and announces each call that
 * starts waiting and each prompt that expires; the tool-call store owns the
 * calls and their answers. Dismissing an expired prompt moves focus to the
 * field. While a call waits, Escape in the field
 * rejects it with the draft as the reason, and Enter without Shift allows it
 * once when the draft is empty or rejects it with the draft as the reason
 * otherwise. A rejection, from the field or the card, clears the draft; Allow
 * anyway keeps it.
 *
 * Files chosen through the add menu or dropped on the field are handed to
 * the store, which reads and admits them and lists them in the tray above
 * the field; they are sent with the next message. Why the store refused a
 * file is said in the field's polite status line, which stays in the page
 * while it has nothing to say. Pasted text stays in the draft, however long
 * it is.
 * The model menu lists the models of every turned-on provider, one labelled
 * group per provider in provider order, each named with its provider.
 * Choosing a model there picks it for the shown conversation only, until
 * another conversation is shown; it changes neither the default nor the
 * settings. While the conversation's model cannot answer, Send stays off and
 * the banner above the field says why, with one action: start the backend,
 * open the settings pane that fixes it, open the model menu, or show the
 * model in the Models pane to load it there. A model whose provider is off,
 * needs a key, or is not reachable stays the conversation's model, and
 * nothing is sent to another provider instead. Context figures come from the
 * backend's measurement of the conversation with its loaded model, plus an
 * estimate of the draft and of the staged images, and are marked `~`
 * wherever they appear; staged text files are read on request, so they are
 * not counted.
 *
 * @param props - Parent-owned ref for the message field and the request
 * for a new conversation.
 * @returns The rendered conversation composer.
 */
export function Composer({
  messageFieldRef,
  onStartConversation
}: ComposerProps): ReactElement {
  const backendServerInfo = useLysStore((state) => state.backendServerInfo)
  const settings = useLysStore((state) => state.settings)
  const providerModels = useLysStore((state) => state.providerModels)
  const setActiveView = useLysStore((state) => state.setActiveView)
  const setSettingsPane = useLysStore((state) => state.setSettingsPane)
  const showModelInSettings = useLysStore((state) => state.showModelInSettings)
  const startBackend = useLysStore((state) => state.startBackend)
  const conversationModel = useConversationModel()

  const attachments = useChatViewStore((state) => state.attachments)
  const attachmentRefusal = useChatViewStore((state) => state.attachmentRefusal)
  const conversation = useChatViewStore((state) => state.conversation)
  const conversationOpen = useChatViewStore((state) => state.conversationOpen)
  const inputDraft = useChatViewStore((state) => state.inputDraft)
  const request = useChatViewStore((state) => state.request)
  const removeAttachment = useChatViewStore((state) => state.removeAttachment)
  const resetConversation = useChatViewStore((state) => state.resetConversation)
  const selectAgent = useChatViewStore((state) => state.selectAgent)
  const sendMessage = useChatViewStore((state) => state.sendMessage)
  const setInputDraft = useChatViewStore((state) => state.setInputDraft)
  const addAttachments = useChatViewStore((state) => state.addAttachments)
  const stopStreaming = useChatViewStore((state) => state.stopStreaming)
  const updateModelPick = useChatViewStore((state) => state.updateModelPick)

  const agentList = useAgentStore((state) => state.list)
  const answeringAgent = useAnsweringAgent()
  const agentName = formatConversationAgentName(answeringAgent)
  const isAgentDeleted = answeringAgent.status === "deleted"

  const isHistoryOpen = useConversationHistoryStore(
    (state) => state.visibility.status === "open"
  )
  const openConversationHistory = useConversationHistoryStore(
    (state) => state.openConversationHistory
  )
  const closeConversationHistory = useConversationHistoryStore(
    (state) => state.closeConversationHistory
  )

  const [isDropping, setIsDropping] = useState(false)
  const [isFocused, setIsFocused] = useState(false)
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const backendStatus = backendServerInfo.status
  const { model, availability } = conversationModel
  const runtime: ComposerRuntime = { backendStatus, settings, providerModels }
  const modelState = buildComposerModelState(runtime, conversationModel)
  const connection = calculateLocalRuntimeConnection(modelState)
  const bannerAction = findComposerBannerAction(modelState)
  const modelGroups = listComposerModelGroups(runtime)
  const isUnavailable = connection !== "ready"
  const activity = calculateComposerActivity(request, conversationOpen)
  const activityLabel = formatComposerActivity(activity)

  const contextMeasurement = useChatContextMeasurement(
    activity === "idle" && !isUnavailable
  )
  const contextMeter = buildContextMeterState(contextMeasurement.outcome, {
    draft: inputDraft,
    attachmentTokens: calculateStagedImageTokens(attachments),
    reserve: settings.generation.replyCeiling
  })
  const hasAttachedTextFiles = attachments.some(
    (attachment) => attachment.draft.kind === "text"
  )
  // A pending measurement may describe another conversation, so only a
  // current one refuses the send; the backend still checks every round.
  const isOverWindow =
    !contextMeasurement.isPending &&
    contextMeter.status === "measured" &&
    contextMeter.usage.overflowTokens > 0

  const canSubmitDraft = inputDraft.trim().length > 0 && !isOverWindow
  const isFieldDisabled = isUnavailable || isAgentDeleted
  const isSendDisabled =
    activity !== "idle" || isFieldDisabled || !canSubmitDraft

  /**
   * Rejects the waiting tool call with the draft as the person's reason, and
   * clears the draft.
   *
   * @param callId - Call that waits for the person.
   */
  function rejectShownToolCall(callId: string): void {
    void useToolCallStore.getState().rejectToolCall(callId, inputDraft)
    setInputDraft("")
  }

  /**
   * Stops showing an expired tool call prompt and moves focus to the message
   * field, because Dismiss leaves with the card.
   *
   * @param callId - Call whose prompt expired.
   */
  function dismissShownToolCall(callId: string): void {
    useToolCallStore.getState().dismissExpiredToolCall(callId)
    messageFieldRef.current?.focus()
  }

  /**
   * Answers the tool call of the shown conversation that waits for the
   * person from the keyboard: Escape rejects it with the draft as the reason,
   * and Enter without Shift allows it when the draft is empty or rejects it
   * with the draft otherwise.
   *
   * @param event - Keyboard event emitted by the composer textarea.
   * @returns Whether the key answered a waiting call; false when no call
   * waits or the key is neither.
   */
  function handleToolCallKeyDown(
    event: KeyboardEvent<HTMLTextAreaElement>
  ): boolean {
    const toolCalls = useToolCallStore.getState()
    const shownToolCall = findShownToolCall(toolCalls, conversation?.id)
    if (shownToolCall?.answer.status !== "awaiting-person") return false

    const callId = shownToolCall.call.id
    if (event.key === "Escape") {
      event.preventDefault()
      rejectShownToolCall(callId)
      return true
    }
    if (event.key !== "Enter" || event.shiftKey) return false

    event.preventDefault()
    if (inputDraft.trim().length > 0) rejectShownToolCall(callId)
    else void toolCalls.resolveToolCall(callId)
    return true
  }

  /**
   * Answers a waiting tool call from the keyboard, or otherwise sends the
   * current draft when Enter is pressed without a Shift modifier.
   *
   * @param event - Keyboard event emitted by the composer textarea.
   * @remarks A key pressed while an input method composes text, such as the
   * Enter that confirms a composition or the Escape that cancels one, is
   * left to the input method and neither sends nor answers anything.
   */
  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.nativeEvent.isComposing) return
    if (handleToolCallKeyDown(event)) return
    if (event.key !== "Enter" || event.shiftKey) return

    event.preventDefault()
    if (isSendDisabled) return
    void sendMessage()
  }

  /**
   * Stages files chosen through the hidden file input.
   *
   * @param event - Change event emitted by the file input.
   * @remarks The chosen files are copied out of the event before staging,
   * because the store reads them after this handler returns, when the input
   * has been reset.
   */
  function handleFilesChosen(event: ChangeEvent<HTMLInputElement>): void {
    const chosenFiles = Array.from(event.currentTarget.files ?? [])
    void addAttachments(chosenFiles)
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
   * @remarks The released files are copied out of the event before staging,
   * because the store reads them after this handler returns, when the
   * browser no longer exposes the drag data.
   */
  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault()
    setIsDropping(false)
    if (isUnavailable) return

    void addAttachments(Array.from(event.dataTransfer.files))
  }

  /** Opens past conversations, or closes them when they are already open. */
  function handleHistoryClick(): void {
    if (isHistoryOpen) {
      closeConversationHistory()
      return
    }

    openConversationHistory()
  }

  /**
   * Carries out the banner's recovery action: starts the backend, opens the
   * settings pane that fixes the missing prerequisite, opens the model menu,
   * or shows the model in the Models pane to be loaded there.
   */
  function handleBannerAction(): void {
    switch (bannerAction.kind) {
      case "start-backend":
        void startBackend()
        return
      case "open-settings":
        setSettingsPane(bannerAction.pane)
        setActiveView("settings")
        return
      case "open-model-menu":
        setIsModelMenuOpen(true)
        return
      case "show-model":
        showModelInSettings(bannerAction.model)
        return
      case "none":
        return
    }
  }

  /** Opens the Providers pane, from the model menu while no provider is on. */
  function handleOpenProviders(): void {
    setSettingsPane("providers")
    setActiveView("settings")
  }

  /** Opens the settings pane that owns the context-window size. */
  function handleChangeWindow(): void {
    setSettingsPane("model")
    setActiveView("settings")
  }

  /** Opens the settings pane that owns the agents. */
  function handleOpenAgentSettings(): void {
    setSettingsPane("agents")
    setActiveView("settings")
  }

  return (
    <footer className="composer">
      {isUnavailable ? (
        <ComposerOfflineBanner
          action={bannerAction}
          message={formatUnavailableRuntimeMessage({
            ...modelState,
            backendAddress: settings.runtime.backendAddress
          })}
          onReconnect={handleBannerAction}
        />
      ) : null}
      <ComposerDeletedAgentNotice
        isShown={isAgentDeleted && !isUnavailable}
        onStartConversation={onStartConversation}
      />

      <div className="composer__inner">
        <ComposerToolCallPrompt
          agentName={agentName}
          onDismissToolCall={dismissShownToolCall}
          onRejectToolCall={rejectShownToolCall}
        />

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
              onRemove={removeAttachment}
            />
          ) : null}
          {/*
           * Each refusal is keyed by its occurrence, so a repeated sentence
           * is added to the status line again and announced again.
           */}
          <output className="composer__attachment-refusal">
            {attachmentRefusal === undefined ? null : (
              <span key={attachmentRefusal.occurrence}>
                {attachmentRefusal.message}
              </span>
            )}
          </output>

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
              aria-label={`Message ${agentName}`}
              className="composer__textarea"
              disabled={isFieldDisabled}
              onBlur={() => setIsFocused(false)}
              onChange={(event) => setInputDraft(event.currentTarget.value)}
              onFocus={() => setIsFocused(true)}
              onKeyDown={handleKeyDown}
              placeholder={formatComposerPlaceholder(
                modelState,
                activity,
                answeringAgent
              )}
              ref={messageFieldRef}
              rows={1}
              value={inputDraft}
            />

            {activity === "awaiting-reply" ? (
              <Button
                aria-label="Stop reply"
                className="composer__send"
                onClick={() => void stopStreaming()}
                type="button"
                variant="secondary"
              >
                Stop
              </Button>
            ) : (
              <Button
                className="composer__send"
                disabled={isSendDisabled}
                onClick={() => void sendMessage()}
                type="button"
              >
                Send
              </Button>
            )}
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
              aria-expanded={isHistoryOpen}
              aria-haspopup="dialog"
              aria-keyshortcuts="Meta+K Control+K"
              className="composer__icon-button"
              onClick={handleHistoryClick}
              title="Past conversations (⌘K)"
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

            <ComposerAgentMenu
              agent={answeringAgent}
              choices={buildAgentChoices(agentList)}
              isConversationStarted={
                conversation !== undefined || activity === "awaiting-reply"
              }
              onOpenAgentSettings={handleOpenAgentSettings}
              onSelectAgent={selectAgent}
              onStartConversation={resetConversation}
            />

            <span aria-hidden="true" className="composer__divider" />

            <ComposerModelMenu
              availability={availability}
              groups={modelGroups}
              isOpen={isModelMenuOpen}
              label={formatComposerModelLabel(
                backendStatus,
                model,
                availability
              )}
              onIsOpenChange={setIsModelMenuOpen}
              onOpenProviders={handleOpenProviders}
              onSelectModel={updateModelPick}
              selectedModel={model}
            />
          </div>

          <div className="composer__meta-right">
            {activityLabel === "" ? null : (
              <span className="composer__activity">{activityLabel}</span>
            )}

            {!isUnavailable ? (
              <ComposerContextMeter
                hasAttachedTextFiles={hasAttachedTextFiles}
                meter={contextMeter}
                onChangeWindow={handleChangeWindow}
              />
            ) : null}
          </div>
        </div>
      </div>
    </footer>
  )
}
