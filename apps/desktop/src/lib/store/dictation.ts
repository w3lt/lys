import { voiceDictationApi } from "@lys/protocol"
import { create, type StoreApi, type UseBoundStore } from "zustand"

import {
  ComposerDictation,
  type DictationSocket,
  type DictationSocketHandlers,
  type DictationView
} from "@/lib/dictation/composer-dictation"
import { openDictationSocket } from "@/lib/dictation/dictation-socket"
import { startMicrophoneRecorder } from "@/lib/dictation/microphone-recorder"
import { useLysStore } from "@/lib/store"
import { getBackendSocketOrigin } from "@/lib/store/backend-socket-origin"
import { useChatViewStore, type ChatViewStore } from "@/lib/store/chat-view"
import { useSpeechActivityStore } from "@/lib/store/speech-activity"

/** The dictation as the composer shows it, with what the composer can ask. */
export type DictationStore = DictationView & {
  /**
   * Handles a press of the dictation button: starts a dictation while none
   * runs and Lys may listen, and stops the running one otherwise.
   *
   * @param cursor - Offset of the cursor in the draft, where a new dictation
   * writes.
   */
  readonly handleDictationPress: (cursor: number) => void
  /** Stops the running dictation as a press of the button does. */
  readonly stopDictation: () => void
  /**
   * Ends the running dictation at once, writing nothing more, and clears
   * the notice.
   */
  readonly cancelDictation: () => void
  /**
   * Cancels the running dictation when something else changed the draft.
   *
   * @param draft - The composer's draft after a change.
   */
  readonly handleDraftChange: (draft: string) => void
}

/** The dictation store's state accessors. */
type DictationStoreApi = Pick<StoreApi<DictationStore>, "getState" | "setState">

/**
 * Answers whether a notice says that voice ended the dictation.
 *
 * @param notice - The notice of a view.
 * @returns True for voice not being ready and for voice having stopped.
 */
function isVoiceNotice(notice: DictationView["notice"]): boolean {
  return notice === "voice-not-ready" || notice === "voice-stopped"
}

/**
 * Answers whether Lys is answering in the chat view or opening a
 * conversation, which is when the composer shows Stop or is off.
 *
 * @param chat - The chat view's state.
 * @returns True while a reply is awaited or streams, and while a stored
 * conversation is read.
 */
function isChatBusy(chat: ChatViewStore): boolean {
  if (chat.conversationOpen.status === "opening") return true
  const status = chat.request.status
  return status === "awaiting-turn" || status === "reply-streaming"
}

/**
 * Answers whether Lys may listen now.
 *
 * @returns True while voice runs and Lys neither answers, opens a
 * conversation, nor talks.
 */
function canListen(): boolean {
  if (useLysStore.getState().voiceServerInfo.status !== "running") return false
  if (useSpeechActivityStore.getState().isTalking) return false
  return !isChatBusy(useChatViewStore.getState())
}

/**
 * Gets the chat view's draft.
 *
 * @returns The text of the message field.
 */
function getDraft(): string {
  return useChatViewStore.getState().inputDraft
}

/**
 * Replaces the chat view's draft.
 *
 * @param draft - The new text of the message field.
 */
function updateDraft(draft: string): void {
  useChatViewStore.getState().setInputDraft(draft)
}

/**
 * Opens the dictation socket of the backend the application store names.
 *
 * @param handlers - Receive each text message and the close.
 * @returns The socket, which takes messages at once.
 */
function openBackendDictationSocket(
  handlers: DictationSocketHandlers
): DictationSocket {
  return openDictationSocket(
    `${getBackendSocketOrigin()}${voiceDictationApi.path}`,
    handlers
  )
}

/**
 * Creates the dictation store's first state over a new composer's dictation.
 *
 * @param store - Reads and writes the store's state.
 * @returns The idle view with the composer's requests.
 */
function createDictationStoreState(store: DictationStoreApi): DictationStore {
  /**
   * Shows a view of the dictation, and has voice's status read again when
   * the view first says that voice ended the dictation.
   *
   * @param view - The dictation's status and notice.
   */
  function handleViewChange(view: DictationView): void {
    const isNewNotice = store.getState().notice !== view.notice
    store.setState(view)
    if (isNewNotice && isVoiceNotice(view.notice)) {
      void useLysStore.getState().updateVoiceServerInfo()
    }
  }

  const dictation = new ComposerDictation({
    getDraft,
    updateDraft,
    startRecorder: startMicrophoneRecorder,
    openSocket: openBackendDictationSocket,
    onViewChange: handleViewChange
  })

  /**
   * Handles a press of the dictation button.
   *
   * @param cursor - Offset of the cursor in the draft.
   */
  function handleDictationPress(cursor: number): void {
    if (store.getState().status === "idle" && !canListen()) return
    dictation.handleButtonPress(cursor)
  }

  return {
    status: "idle",
    notice: undefined,
    isAtDraftEnd: false,
    handleDictationPress,
    stopDictation: () => {
      dictation.stop()
    },
    cancelDictation: () => {
      dictation.cancel()
    },
    handleDraftChange: (draft) => {
      dictation.handleDraftChange(draft)
    }
  }
}

/**
 * The dictation store the composer uses.
 *
 * @remarks This singleton runs dictations against the chat view's draft, the
 * backend origin the application store names when a dictation starts, and
 * the platform's microphone. It owns the composer's dictation, which owns
 * the microphone and the socket of the running dictation;
 * {@link DictationStore.cancelDictation} releases them. It refuses to start
 * while voice does not run, while Lys answers or talks, and while a
 * conversation is opening; {@link registerDictationRules} ends a running
 * dictation when one of those begins. When a dictation ends because voice
 * was not ready or stopped, it has voice's status read again.
 */
export const useDictationStore: UseBoundStore<StoreApi<DictationStore>> =
  create<DictationStore>((setState, getState) =>
    createDictationStoreState({ getState, setState })
  )

/**
 * Applies a change of the chat view to the running dictation.
 *
 * @param chat - The chat view's state after the change.
 * @param previous - Its state before the change.
 * @remarks Another conversation, or one that starts to open, cancels the
 * dictation, as does a draft something else changed; a reply that starts
 * stops it.
 */
function handleChatChange(chat: ChatViewStore, previous: ChatViewStore): void {
  const dictation = useDictationStore.getState()
  if (
    chat.conversation?.id !== previous.conversation?.id ||
    chat.conversationOpen.status === "opening"
  ) {
    dictation.cancelDictation()
    return
  }
  if (chat.inputDraft !== previous.inputDraft) {
    dictation.handleDraftChange(chat.inputDraft)
  }
  if (isChatBusy(chat)) dictation.stopDictation()
}

/** Stops the running dictation once Lys may no longer listen. */
function stopDisallowedDictation(): void {
  if (!canListen()) useDictationStore.getState().stopDictation()
}

/**
 * Starts ending the running dictation when what allowed it ends.
 *
 * @returns The unsubscribe, which stops following the stores and cancels the
 * running dictation, releasing the microphone.
 * @remarks Subscribes to the chat view, the application store, and the
 * speech activity. A dictation is cancelled, writing nothing more, when the
 * shown conversation changes or starts to be replaced, and when something
 * else changes the draft. It is stopped as a press of its button stops it,
 * so its final text still arrives, when Lys starts answering or talking and
 * when voice stops running. The application shell registers it once while
 * it is mounted; nothing subscribes when this module is evaluated.
 */
export function registerDictationRules(): () => void {
  const stopFollowingChat = useChatViewStore.subscribe(handleChatChange)
  const stopFollowingVoice = useLysStore.subscribe(stopDisallowedDictation)
  const stopFollowingSpeech = useSpeechActivityStore.subscribe(
    stopDisallowedDictation
  )
  return () => {
    stopFollowingSpeech()
    stopFollowingVoice()
    stopFollowingChat()
    useDictationStore.getState().cancelDictation()
  }
}
