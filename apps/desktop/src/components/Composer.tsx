import { useRef, useState } from "react"
import type {
  ChangeEvent,
  DragEvent,
  KeyboardEvent,
  ReactElement,
  RefObject
} from "react"
import { Menu, Plus, Settings } from "lucide-react"

import type { SettingsPane } from "@/app/types"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { useAnsweringAgent } from "@/lib/hooks/answeringAgent"
import { useChatContextMeasurement } from "@/lib/hooks/chatContextMeasurement"
import { useConversationModel } from "@/lib/hooks/conversationModel"
import { useLysStore } from "@/lib/store"
import { useAgentStore } from "@/lib/store/agents"
import {
  buildAgentChoices,
  formatConversationAgentName,
  type ConversationAgent
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
import {
  buildContextMeterState,
  type ContextMeterState
} from "./ComposerComponents/composer-context"
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
  type ComposerActivity,
  type ComposerModelGroup,
  type ComposerModelState,
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

/** The conversation's model as the composer shows it. */
type ComposerModelView = {
  /** What the banner, the placeholder, and Send read of the model. */
  readonly state: ComposerModelState
  /** Whether the model cannot answer now, which turns the field off. */
  readonly isUnavailable: boolean
  /** The model menu's groups, one per turned-on provider in provider order. */
  readonly groups: readonly ComposerModelGroup[]
}

/** What the composer knows of the context its next message would take. */
type ComposerContextView = {
  /** The meter: the measured parts with the draft's and the images' estimates. */
  readonly meter: ContextMeterState
  /** Whether text files are staged, which the meter does not count. */
  readonly hasAttachedTextFiles: boolean
  /** Whether the current measurement with the draft exceeds the window. */
  readonly isOverWindow: boolean
}

/** The composer's answers to the shown tool call that touch its own field. */
type ShownToolCallAnswers = {
  /**
   * Rejects the waiting call with the draft as the person's reason, and
   * clears the draft.
   *
   * @param callId - Call that waits for the person.
   */
  readonly rejectToolCall: (callId: string) => void
  /**
   * Stops showing an expired prompt and moves focus to the message field,
   * because Dismiss leaves with the card.
   *
   * @param callId - Call whose prompt expired.
   */
  readonly dismissToolCall: (callId: string) => void
}

/** The composer field's handling of files dragged over it. */
type ComposerFileDrop = {
  /** Whether files are dragged over the field while they can be added. */
  readonly isDropping: boolean
  /**
   * Marks the field as an active drop target.
   *
   * @param event - Drag event observed over the field.
   */
  readonly handleDragOver: (event: DragEvent<HTMLDivElement>) => void
  /**
   * Clears the drop target once the pointer leaves the field entirely.
   *
   * @param event - Drag event observed leaving the field.
   */
  readonly handleDragLeave: (event: DragEvent<HTMLDivElement>) => void
  /**
   * Stages the files released over the field.
   *
   * @param event - Drop event carrying the released files.
   */
  readonly handleDrop: (event: DragEvent<HTMLDivElement>) => void
}

/**
 * Observes the model the composer's next message goes to, whether it can
 * answer, and what the model menu offers.
 *
 * @returns The model with its availability and the provider the composer
 * names, whether the model cannot answer, and one menu group per turned-on
 * provider; recalculated on every render, which follows the backend's state,
 * the settings, every provider's state, and the conversation's model.
 * @remarks The application store owns the backend's state, the settings, and
 * every provider's state; the chat-view store owns the model pick. The hook
 * only reads them.
 */
function useComposerModel(): ComposerModelView {
  const backendStatus = useLysStore((state) => state.backendServerInfo.status)
  const settings = useLysStore((state) => state.settings)
  const providerModels = useLysStore((state) => state.providerModels)
  const conversationModel = useConversationModel()
  const runtime: ComposerRuntime = { backendStatus, settings, providerModels }
  const state = buildComposerModelState(runtime, conversationModel)

  return {
    state,
    isUnavailable: calculateLocalRuntimeConnection(state) !== "ready",
    groups: listComposerModelGroups(runtime)
  }
}

/**
 * Reads the application's way to show one settings pane.
 *
 * @returns A function that selects a pane and then shows the settings view,
 * changing the application store at once; a new function on every render.
 * @remarks The application store owns the active view and the settings pane.
 */
function useSettingsPaneOpener(): (pane: SettingsPane) => void {
  const setActiveView = useLysStore((state) => state.setActiveView)
  const setSettingsPane = useLysStore((state) => state.setSettingsPane)

  /**
   * Selects a settings pane and shows the settings view.
   *
   * @param pane - Pane to show.
   */
  function openSettingsPane(pane: SettingsPane): void {
    setSettingsPane(pane)
    setActiveView("settings")
  }

  return openSettingsPane
}

/**
 * Measures the context the composer's next message would take, with the
 * draft's and the staged images' estimates added.
 *
 * @param isComposerIdle - Reactive: whether the composer could send now. No
 * measurement starts while it cannot; the last outcome stays as it was.
 * @returns The meter, whether text files are staged, and whether the current
 * measurement with the draft exceeds the window; recalculated on every
 * render, which follows the draft, the staged files, the reply ceiling, and
 * each settled measurement.
 * @remarks The chat-view store owns the draft and the staged files, and the
 * application store the reply ceiling the meter reserves. Staged text files
 * are read on request, so they are not counted. Only a current measurement
 * refuses the send: a pending one may describe another conversation, and the
 * backend still checks every round.
 */
function useComposerContextMeter(isComposerIdle: boolean): ComposerContextView {
  const attachments = useChatViewStore((state) => state.attachments)
  const inputDraft = useChatViewStore((state) => state.inputDraft)
  const replyCeiling = useLysStore(
    (state) => state.settings.generation.replyCeiling
  )
  const measurement = useChatContextMeasurement(isComposerIdle)
  const meter = buildContextMeterState(measurement.outcome, {
    draft: inputDraft,
    attachmentTokens: calculateStagedImageTokens(attachments),
    reserve: replyCeiling
  })

  return {
    meter,
    hasAttachedTextFiles: attachments.some(
      (attachment) => attachment.draft.kind === "text"
    ),
    isOverWindow:
      !measurement.isPending &&
      meter.status === "measured" &&
      meter.usage.overflowTokens > 0
  }
}

/**
 * Provides the answers to the shown conversation's tool call that use the
 * draft or the message field.
 *
 * @param messageFieldRef - Parent-owned host of the message field; read when
 * a dismissal moves focus.
 * @returns The rejection and the dismissal, each a new function on every
 * render that answers with the draft of that render.
 * @remarks The tool-call store owns the calls and sends the answers; the
 * chat-view store owns the draft, which a rejection clears at once without
 * waiting for the answer to be sent.
 */
function useShownToolCallAnswers(
  messageFieldRef: RefObject<HTMLTextAreaElement | null>
): ShownToolCallAnswers {
  const inputDraft = useChatViewStore((state) => state.inputDraft)
  const setInputDraft = useChatViewStore((state) => state.setInputDraft)

  /**
   * Rejects the waiting tool call with the draft as the person's reason, and
   * clears the draft.
   *
   * @param callId - Call that waits for the person.
   */
  function rejectToolCall(callId: string): void {
    void useToolCallStore.getState().rejectToolCall(callId, inputDraft)
    setInputDraft("")
  }

  /**
   * Stops showing an expired tool call prompt and moves focus to the message
   * field, because Dismiss leaves with the card.
   *
   * @param callId - Call whose prompt expired.
   */
  function dismissToolCall(callId: string): void {
    useToolCallStore.getState().dismissExpiredToolCall(callId)
    messageFieldRef.current?.focus()
  }

  return { rejectToolCall, dismissToolCall }
}

/**
 * Tracks files dragged over the composer field and stages the files dropped
 * on it.
 *
 * @param isUnavailable - Reactive: whether the conversation's model cannot
 * answer; files are then neither marked nor staged.
 * @returns Whether files are dragged over the field while they can be added,
 * and the field's drag handlers, each a new function on every render.
 * @remarks The hook owns whether a drag is over the field, reset by a drop or
 * by the pointer leaving the field; the chat-view store reads and admits the
 * dropped files. Every drag over the field and every drop prevents the
 * browser's default, so a dropped file is not opened.
 */
function useComposerFileDrop(isUnavailable: boolean): ComposerFileDrop {
  const addAttachments = useChatViewStore((state) => state.addAttachments)
  const [isDropping, setIsDropping] = useState(false)

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

  return {
    isDropping: isDropping && !isUnavailable,
    handleDragOver,
    handleDragLeave,
    handleDrop
  }
}

/** Properties accepted by {@link ComposerRecoveryBanner}. */
type ComposerRecoveryBannerProps = {
  /** What the composer knows of the conversation's model. */
  readonly modelState: ComposerModelState
  /** Requests that the parent open the model menu. */
  readonly onOpenModelMenu: () => void
}

/**
 * States why the conversation's model cannot answer, while it cannot, and
 * carries out the banner's recovery action.
 *
 * @remarks The parent owns the model's state and the model menu; the
 * application store owns the backend address named in the sentence and the
 * actions the banner takes. The action starts a stopped backend, opens the
 * settings pane that fixes the missing prerequisite, asks the parent to open
 * the model menu, or shows the model in the Models pane to be loaded there;
 * while the state already changes it does nothing, and the banner disables
 * it. The component owns no state.
 * @param props - The model's state and the request to open the model menu.
 * @returns The banner while the model cannot answer, or nothing while it can.
 */
function ComposerRecoveryBanner({
  modelState,
  onOpenModelMenu
}: ComposerRecoveryBannerProps): ReactElement | null {
  const backendAddress = useLysStore(
    (state) => state.settings.runtime.backendAddress
  )
  const startBackend = useLysStore((state) => state.startBackend)
  const showModelInSettings = useLysStore((state) => state.showModelInSettings)
  const openSettingsPane = useSettingsPaneOpener()
  const action = findComposerBannerAction(modelState)

  /**
   * Carries out the banner's recovery action: starts the backend, opens the
   * settings pane that fixes the missing prerequisite, opens the model menu,
   * or shows the model in the Models pane to be loaded there.
   */
  function handleBannerAction(): void {
    switch (action.kind) {
      case "start-backend":
        void startBackend()
        return
      case "open-settings":
        openSettingsPane(action.pane)
        return
      case "open-model-menu":
        onOpenModelMenu()
        return
      case "show-model":
        showModelInSettings(action.model)
        return
      case "none":
        return
    }
  }

  if (calculateLocalRuntimeConnection(modelState) === "ready") return null

  return (
    <ComposerOfflineBanner
      action={action}
      message={formatUnavailableRuntimeMessage({
        ...modelState,
        backendAddress
      })}
      onReconnect={handleBannerAction}
    />
  )
}

/**
 * Lists the files staged for the next message and says why the store
 * refused a file.
 *
 * @remarks The chat-view store owns the staged files, their removal, and the
 * last refusal; the component owns no state. The tray is rendered only while
 * a file is staged. The refusal is said in a polite status line that stays
 * in the page while it has nothing to say, and a repeated refusal is
 * announced again.
 * @returns The tray, when files are staged, and the refusal status line.
 */
function ComposerStagedAttachments(): ReactElement {
  const attachments = useChatViewStore((state) => state.attachments)
  const attachmentRefusal = useChatViewStore((state) => state.attachmentRefusal)
  const removeAttachment = useChatViewStore((state) => state.removeAttachment)

  return (
    <>
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
    </>
  )
}

/** Properties accepted by {@link ComposerFileChooser}. */
type ComposerFileChooserProps = {
  /** Whether files cannot be chosen, while the model cannot answer. */
  readonly isDisabled: boolean
}

/**
 * Offers choosing files for the next message through the add menu.
 *
 * @remarks The chat-view store owns the staged files and reads and admits
 * the chosen ones; the component owns the hidden file input, which the
 * menu's Attach a file opens and which is emptied after every choice, so the
 * same file can be chosen again. The add menu is disabled while files cannot
 * be chosen.
 * @param props - Whether choosing is off.
 * @returns The hidden file input and the add menu.
 */
function ComposerFileChooser({
  isDisabled
}: ComposerFileChooserProps): ReactElement {
  const hasAttachments = useChatViewStore(
    (state) => state.attachments.length > 0
  )
  const addAttachments = useChatViewStore((state) => state.addAttachments)
  const fileInputRef = useRef<HTMLInputElement>(null)

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

  return (
    <>
      <input
        className="composer__file-input"
        multiple
        onChange={handleFilesChosen}
        ref={fileInputRef}
        type="file"
      />

      <ComposerPlusMenu
        disabled={isDisabled}
        hasAttachments={hasAttachments}
        onAttachFile={() => fileInputRef.current?.click()}
      />
    </>
  )
}

/** Properties accepted by {@link ComposerMessageInput}. */
type ComposerMessageInputProps = {
  /** Name of the agent that answers, which names the field. */
  readonly agentName: string
  /** Text shown while the draft is empty. */
  readonly placeholder: string
  /** Whether the field is off: the model cannot answer or the agent was deleted. */
  readonly isDisabled: boolean
  /** Whether Enter cannot send the draft now. */
  readonly isSendDisabled: boolean
  /** Parent-owned host the field is attached to. */
  readonly messageFieldRef: RefObject<HTMLTextAreaElement | null>
  /**
   * Tells the parent that the field gained or lost focus.
   *
   * @param isFocused - Whether the field has focus now.
   */
  readonly onIsFocusedChange: (isFocused: boolean) => void
  /**
   * Requests that the parent reject the waiting tool call with the draft as
   * the reason, and clear the draft.
   *
   * @param callId - Call that waits for the person.
   */
  readonly onRejectToolCall: (callId: string) => void
}

/**
 * Edits the draft, sends it from the keyboard, and answers a waiting tool
 * call from the keyboard.
 *
 * @remarks The chat-view store owns the draft, the shown conversation, and
 * sending; the tool-call store owns the calls, read when a key is pressed.
 * While a call of the shown conversation waits for the person, Escape
 * rejects it through the parent, and Enter without Shift allows it once when
 * the draft is empty or rejects it through the parent otherwise. With no
 * call waiting, Enter without Shift sends the draft once unless sending is
 * off, and suppresses the newline either way; Shift+Enter keeps it. A key
 * pressed while an input method composes text is left to the input method.
 * The field is named after the answering agent, and it tells the parent when
 * it gains or loses focus.
 * @param props - The field's name, placeholder, availability, host, and the
 * parent's focus tracking and rejection.
 * @returns The message field.
 */
function ComposerMessageInput({
  agentName,
  placeholder,
  isDisabled,
  isSendDisabled,
  messageFieldRef,
  onIsFocusedChange,
  onRejectToolCall
}: ComposerMessageInputProps): ReactElement {
  const conversationId = useChatViewStore((state) => state.conversation?.id)
  const inputDraft = useChatViewStore((state) => state.inputDraft)
  const setInputDraft = useChatViewStore((state) => state.setInputDraft)
  const sendMessage = useChatViewStore((state) => state.sendMessage)

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
    const shownToolCall = findShownToolCall(toolCalls, conversationId)
    if (shownToolCall?.answer.status !== "awaiting-person") return false

    const callId = shownToolCall.call.id
    if (event.key === "Escape") {
      event.preventDefault()
      onRejectToolCall(callId)
      return true
    }
    if (event.key !== "Enter" || event.shiftKey) return false

    event.preventDefault()
    if (inputDraft.trim().length > 0) onRejectToolCall(callId)
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

  return (
    <Textarea
      aria-label={`Message ${agentName}`}
      className="composer__textarea"
      disabled={isDisabled}
      onBlur={() => onIsFocusedChange(false)}
      onChange={(event) => setInputDraft(event.currentTarget.value)}
      onFocus={() => onIsFocusedChange(true)}
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      ref={messageFieldRef}
      rows={1}
      value={inputDraft}
    />
  )
}

/** Properties accepted by {@link ComposerSendButton}. */
type ComposerSendButtonProps = {
  /** Chat work that keeps the composer from sending. */
  readonly activity: ComposerActivity
  /** Whether Send is off. */
  readonly isSendDisabled: boolean
}

/**
 * Presents the composer's primary control: Stop while a reply is awaited,
 * and Send otherwise.
 *
 * @remarks The chat-view store owns sending and stopping, and their
 * completion and failure. Send sends the draft once per press. Stop asks the
 * store to stop the awaited reply, which keeps the draft and the staged
 * files; it is named Stop reply for assistive technology. The component owns
 * no state.
 * @param props - The composer's activity and whether Send is off.
 * @returns The Stop or the Send button.
 */
function ComposerSendButton({
  activity,
  isSendDisabled
}: ComposerSendButtonProps): ReactElement {
  const sendMessage = useChatViewStore((state) => state.sendMessage)
  const stopStreaming = useChatViewStore((state) => state.stopStreaming)

  if (activity === "awaiting-reply") {
    return (
      <Button
        aria-label="Stop reply"
        className="composer__send"
        onClick={() => void stopStreaming()}
        type="button"
        variant="secondary"
      >
        Stop
      </Button>
    )
  }

  return (
    <Button
      className="composer__send"
      disabled={isSendDisabled}
      onClick={() => void sendMessage()}
      type="button"
    >
      Send
    </Button>
  )
}

/** Properties accepted by {@link ComposerField}. */
type ComposerFieldProps = {
  /** Chat work that keeps the composer from sending. */
  readonly activity: ComposerActivity
  /** The agent that answers the next message. */
  readonly agent: ConversationAgent
  /** What the composer knows of the conversation's model. */
  readonly modelState: ComposerModelState
  /** Whether the current measurement with the draft exceeds the window. */
  readonly isOverWindow: boolean
  /** Parent-owned host the message field is attached to. */
  readonly messageFieldRef: RefObject<HTMLTextAreaElement | null>
  /**
   * Requests that the parent reject the waiting tool call with the draft as
   * the reason, and clear the draft.
   *
   * @param callId - Call that waits for the person.
   */
  readonly onRejectToolCall: (callId: string) => void
}

/**
 * Presents the composer's field: the staged files, the message row, and the
 * drop target around them.
 *
 * @remarks The chat-view store owns the draft. The field owns whether a drag
 * is over it and whether its message field has focus, and marks both on its
 * host. The message field and the add menu are off while the model cannot
 * answer, and the message field also while the agent was deleted. Send needs
 * a draft that is not blank and, once measured, fits the window, and is off
 * while chat work runs or the field is off. Files dropped while the model
 * cannot answer are not staged.
 * @param props - The composer's activity, agent, model state, window
 * overflow, the message field's host, and the parent's rejection.
 * @returns The composer field.
 */
function ComposerField({
  activity,
  agent,
  modelState,
  isOverWindow,
  messageFieldRef,
  onRejectToolCall
}: ComposerFieldProps): ReactElement {
  const inputDraft = useChatViewStore((state) => state.inputDraft)
  const isUnavailable = calculateLocalRuntimeConnection(modelState) !== "ready"
  const drop = useComposerFileDrop(isUnavailable)
  const [isFocused, setIsFocused] = useState(false)
  const isFieldDisabled = isUnavailable || agent.status === "deleted"
  const canSubmitDraft = inputDraft.trim().length > 0 && !isOverWindow
  const isSendDisabled =
    activity !== "idle" || isFieldDisabled || !canSubmitDraft

  return (
    <div
      className="composer__field"
      data-dropping={drop.isDropping ? "" : undefined}
      data-focused={isFocused ? "" : undefined}
      onDragLeave={drop.handleDragLeave}
      onDragOver={drop.handleDragOver}
      onDrop={drop.handleDrop}
    >
      <ComposerStagedAttachments />

      <div className="composer__row">
        <ComposerFileChooser isDisabled={isUnavailable} />

        <ComposerMessageInput
          agentName={formatConversationAgentName(agent)}
          isDisabled={isFieldDisabled}
          isSendDisabled={isSendDisabled}
          messageFieldRef={messageFieldRef}
          onIsFocusedChange={setIsFocused}
          onRejectToolCall={onRejectToolCall}
          placeholder={formatComposerPlaceholder(modelState, activity, agent)}
        />

        <ComposerSendButton
          activity={activity}
          isSendDisabled={isSendDisabled}
        />
      </div>

      {drop.isDropping ? (
        <span aria-hidden="true" className="composer__drop">
          release to add to context
        </span>
      ) : null}
    </div>
  )
}

/**
 * Offers a new conversation, past conversations, and the settings view.
 *
 * @remarks The chat-view store resets the conversation, the history store
 * owns whether past conversations are shown, and the application store owns
 * the active view; the component owns no state. The Past conversations
 * button opens history, or closes it when open, exposes that state through
 * `aria-expanded`, and names its Command+K or Control+K shortcut. Each
 * button is named by hidden text beside its icon and titled for the pointer.
 * @returns The New conversation, Past conversations, and Settings buttons.
 */
function ComposerNavigationButtons(): ReactElement {
  const resetConversation = useChatViewStore((state) => state.resetConversation)
  const setActiveView = useLysStore((state) => state.setActiveView)
  const isHistoryOpen = useConversationHistoryStore(
    (state) => state.visibility.status === "open"
  )
  const openConversationHistory = useConversationHistoryStore(
    (state) => state.openConversationHistory
  )
  const closeConversationHistory = useConversationHistoryStore(
    (state) => state.closeConversationHistory
  )

  /** Opens past conversations, or closes them when they are already open. */
  function handleHistoryClick(): void {
    if (isHistoryOpen) {
      closeConversationHistory()
      return
    }

    openConversationHistory()
  }

  return (
    <>
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
    </>
  )
}

/** Properties accepted by {@link ComposerSessionControls}. */
type ComposerSessionControlsProps = {
  /** Chat work that keeps the composer from sending. */
  readonly activity: ComposerActivity
  /** The agent that answers the next message. */
  readonly agent: ConversationAgent
  /** What the composer knows of the conversation's model. */
  readonly modelState: ComposerModelState
  /** The model menu's groups, one per turned-on provider. */
  readonly modelGroups: readonly ComposerModelGroup[]
  /** Whether the model menu is open; the parent owns it. */
  readonly isModelMenuOpen: boolean
  /**
   * Proposes opening or closing the model menu.
   *
   * @param isOpen - Proposed state, shown once the parent passes it back.
   */
  readonly onIsModelMenuOpenChange: (isOpen: boolean) => void
}

/**
 * Presents the composer's session controls: the navigation buttons, the
 * agent menu, and the model menu.
 *
 * @remarks The parent owns the agent, the model's state, the menu's groups,
 * and whether the model menu is open; the chat-view store owns the shown
 * conversation, the agent selection, and the model pick; the agent store
 * owns the agents offered; the application store owns the settings view. The
 * agent is fixed once a conversation is shown or its first reply is awaited;
 * before that, choosing an agent selects it for the new conversation. The
 * agent menu's Start a new one resets the conversation and keeps the menu
 * open. Choosing a model picks it for the shown conversation only. Edit
 * agents opens the Agents pane, and the model menu's Open Providers the
 * Providers pane. The component owns no state.
 * @param props - The activity, agent, model state, menu groups, and the
 * model menu's open state with its proposal.
 * @returns The composer's session controls.
 */
function ComposerSessionControls({
  activity,
  agent,
  modelState,
  modelGroups,
  isModelMenuOpen,
  onIsModelMenuOpenChange
}: ComposerSessionControlsProps): ReactElement {
  const agentList = useAgentStore((state) => state.list)
  const isConversationShown = useChatViewStore(
    (state) => state.conversation !== undefined
  )
  const resetConversation = useChatViewStore((state) => state.resetConversation)
  const selectAgent = useChatViewStore((state) => state.selectAgent)
  const updateModelPick = useChatViewStore((state) => state.updateModelPick)
  const openSettingsPane = useSettingsPaneOpener()
  const { backendStatus, model, availability } = modelState

  return (
    <div className="composer__actions">
      <ComposerNavigationButtons />

      <span aria-hidden="true" className="composer__divider" />

      <ComposerAgentMenu
        agent={agent}
        choices={buildAgentChoices(agentList)}
        isConversationStarted={
          isConversationShown || activity === "awaiting-reply"
        }
        onOpenAgentSettings={() => openSettingsPane("agents")}
        onSelectAgent={selectAgent}
        onStartConversation={resetConversation}
      />

      <span aria-hidden="true" className="composer__divider" />

      <ComposerModelMenu
        availability={availability}
        groups={modelGroups}
        isOpen={isModelMenuOpen}
        label={formatComposerModelLabel(backendStatus, model, availability)}
        onIsOpenChange={onIsModelMenuOpenChange}
        onOpenProviders={() => openSettingsPane("providers")}
        onSelectModel={updateModelPick}
        selectedModel={model}
      />
    </div>
  )
}

/** Properties accepted by {@link ComposerStatus}. */
type ComposerStatusProps = {
  /** Chat work that keeps the composer from sending. */
  readonly activity: ComposerActivity
  /** Whether the conversation's model cannot answer; the meter is then hidden. */
  readonly isModelUnavailable: boolean
  /** The context meter's state. */
  readonly meter: ContextMeterState
  /** Whether text files are staged, which the meter does not count. */
  readonly hasAttachedTextFiles: boolean
}

/**
 * Presents what the composer is doing and the context meter.
 *
 * @remarks The parent owns the activity, the meter, and whether the model can
 * answer; the application store owns the settings view. The activity is
 * named only while chat work runs. The meter is shown only while the model
 * can answer, and its Change the window opens the Models pane, which owns the
 * window's size. The component owns no state.
 * @param props - The activity, the model's unavailability, the meter, and
 * whether text files are staged.
 * @returns The composer's status area.
 */
function ComposerStatus({
  activity,
  isModelUnavailable,
  meter,
  hasAttachedTextFiles
}: ComposerStatusProps): ReactElement {
  const openSettingsPane = useSettingsPaneOpener()
  const activityLabel = formatComposerActivity(activity)

  return (
    <div className="composer__meta-right">
      {activityLabel === "" ? null : (
        <span className="composer__activity">{activityLabel}</span>
      )}

      {!isModelUnavailable ? (
        <ComposerContextMeter
          hasAttachedTextFiles={hasAttachedTextFiles}
          meter={meter}
          onChangeWindow={() => openSettingsPane("model")}
        />
      ) : null}
    </div>
  )
}

/**
 * Presents the chat draft editor, its context tray, and the session controls.
 *
 * @remarks The application store owns
 * runtime availability and persisted settings; the chat-view store owns the
 * draft, the staged attachment tray, the conversation, the request
 * lifecycle, and conversation opening; the history store owns whether past
 * conversations are shown. This component owns only transient composer
 * state: whether the model menu is open, whether a drag is over the field,
 * and whether the field has focus. The parent owns the
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
  const agent = useAnsweringAgent()
  const model = useComposerModel()
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false)
  const activity = useChatViewStore((state) =>
    calculateComposerActivity(state.request, state.conversationOpen)
  )
  const context = useComposerContextMeter(
    activity === "idle" && !model.isUnavailable
  )
  const toolCallAnswers = useShownToolCallAnswers(messageFieldRef)

  return (
    <footer className="composer">
      <ComposerRecoveryBanner
        modelState={model.state}
        onOpenModelMenu={() => setIsModelMenuOpen(true)}
      />
      <ComposerDeletedAgentNotice
        isShown={agent.status === "deleted" && !model.isUnavailable}
        onStartConversation={onStartConversation}
      />

      <div className="composer__inner">
        <ComposerToolCallPrompt
          agentName={formatConversationAgentName(agent)}
          onDismissToolCall={toolCallAnswers.dismissToolCall}
          onRejectToolCall={toolCallAnswers.rejectToolCall}
        />

        <ComposerField
          activity={activity}
          agent={agent}
          isOverWindow={context.isOverWindow}
          messageFieldRef={messageFieldRef}
          modelState={model.state}
          onRejectToolCall={toolCallAnswers.rejectToolCall}
        />

        <div className="composer__meta">
          <ComposerSessionControls
            activity={activity}
            agent={agent}
            isModelMenuOpen={isModelMenuOpen}
            modelGroups={model.groups}
            modelState={model.state}
            onIsModelMenuOpenChange={setIsModelMenuOpen}
          />

          <ComposerStatus
            activity={activity}
            hasAttachedTextFiles={context.hasAttachedTextFiles}
            isModelUnavailable={model.isUnavailable}
            meter={context.meter}
          />
        </div>
      </div>
    </footer>
  )
}
