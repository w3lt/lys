/**
 * Wires the speech controller to the application: the chat view's store, the
 * voice lifecycle in the application store, the window's focus, the Web
 * Audio player, and the backend's speech and notification sockets.
 *
 * @remarks {@link startSpeech} is called once from the application shell and
 * returns the cleanup for it. The chat stream itself stays on SSE; speech is
 * a separate channel the person can have or not have without changing what
 * the chat shows.
 */
import { getCurrentWindow } from "@tauri-apps/api/window"
import { chatNotificationApi, chatSpeechApi } from "@lys/protocol"

import { useChatViewStore } from "@/lib/store/chat-view"
import { useLysStore } from "@/lib/store"
import {
  SpeechController,
  type SpeechObservation,
  type SpeechReply
} from "./speech-controller"
import { createPcmPlayer } from "./pcm-player"

/** Tauri `webviewWindow` focus events, with a DOM fallback for other shells. */
function trackFocus(onChange: (focused: boolean) => void): () => void {
  try {
    const currentWindow = getCurrentWindow()
    let focused = true
    let unlisten: (() => void) | undefined
    let disposed = false
    void currentWindow
      .isFocused()
      .then((value) => {
        focused = value
        onChange(value)
      })
      .catch(() => {
        // The window never reported; the default stands.
      })
    const rememberUnlisten = (unlistenFocus: () => void): void => {
      if (disposed) unlistenFocus()
      else unlisten = unlistenFocus
    }
    void currentWindow
      .onFocusChanged(({ payload }) => {
        focused = payload
        onChange(focused)
      })
      .then(rememberUnlisten)
      .catch(() => {
        // Focus events are unavailable; focus stays at its last value.
      })
    return () => {
      disposed = true
      unlisten?.()
    }
  } catch {
    const onFocus = () => {
      onChange(true)
    }
    const onBlur = () => {
      onChange(false)
    }
    window.addEventListener("focus", onFocus)
    window.addEventListener("blur", onBlur)
    return () => {
      window.removeEventListener("focus", onFocus)
      window.removeEventListener("blur", onBlur)
    }
  }
}

/** Backend base as a WebSocket origin: `http` becomes `ws`. */
function webSocketOrigin(): string {
  return useLysStore.getState().backendUrl.replace(/^http/, "ws")
}

/** Fills one speech path parameter pair with the reply's identifiers. */
function speechPath(
  template: string,
  reply: SpeechReply,
  query?: string
): string {
  const path = template
    .replace(":conversationId", encodeURIComponent(reply.conversationId))
    .replace(":assistantMessageId", encodeURIComponent(reply.replyId))
  return query === undefined ? path : `${path}?${query}`
}

/**
 * Reads the chat view's store into the controller's observation.
 *
 * @param previousRequestStatus - The request status seen at the previous
 * call, which is what tells a reply the person asked for from one the view
 * joined; pass `undefined` for the first read.
 */
function buildObservation(
  previousRequestStatus: string | undefined
): SpeechObservation {
  const { conversation, request } = useChatViewStore.getState()
  if (conversation === undefined) return { kind: "none" }
  if (request.status === "reply-streaming") {
    return {
      kind: "streaming",
      reply: {
        conversationId: conversation.id,
        replyId: request.assistantMessageId
      },
      beganAsNewTurn: previousRequestStatus === "awaiting-turn"
    }
  }
  if (request.status === "reply-completed") {
    const message = conversation.messages.find(
      (candidate) => candidate.id === request.assistantMessageId
    )
    const status =
      message?.role === "assistant" && message.status !== "streaming"
        ? message.status
        : undefined
    if (status === undefined) return { kind: "none" }
    return {
      kind: "settled",
      reply: {
        conversationId: conversation.id,
        replyId: request.assistantMessageId
      },
      status
    }
  }
  return { kind: "none" }
}

/**
 * Passes one binary WebSocket message to the handler, if it is one.
 *
 * @param event - The message event the socket received.
 * @param handlers - The controller's socket handlers.
 */
function forwardBinaryFrame(
  event: MessageEvent,
  handlers: { onAudio: (frame: Uint8Array) => void }
): void {
  if (event.data instanceof ArrayBuffer) {
    handlers.onAudio(new Uint8Array(event.data))
  }
}

/**
 * Starts the speech controller.
 *
 * @returns A cleanup that stops the controller and its subscriptions.
 * @remarks Idempotent within one call only: callers must call the returned
 * cleanup rather than start twice.
 */
export function startSpeech(): () => void {
  const isVoiceReady = (): boolean =>
    useLysStore.getState().voiceServerInfo.status === "running"

  let focused = true
  const controller = new SpeechController({
    isFocused: () => focused,
    isVoiceReady,
    speechPath: (reply, from) =>
      speechPath(chatSpeechApi.path, reply, `from=${from}`),
    notificationPath: (reply) => speechPath(chatNotificationApi.path, reply),
    openSocket: (path, handlers) => {
      const socket = new WebSocket(`${webSocketOrigin()}${path}`)
      socket.binaryType = "arraybuffer"
      socket.addEventListener("message", (event) => {
        forwardBinaryFrame(event, handlers)
      })
      socket.addEventListener("close", (event) => {
        handlers.onClose(event.code)
      })
      // The error is followed by a close; nothing more to do here.
      return { close: () => socket.close() }
    },
    createPlayer: () => createPcmPlayer()
  })

  const update = (previousRequestStatus?: string): void => {
    controller.update(buildObservation(previousRequestStatus))
  }

  const unsubscribeChat = useChatViewStore.subscribe(
    (_state, previousState) => {
      update(previousState.request.status)
    }
  )
  type LysStoreState = ReturnType<typeof useLysStore.getState>
  const onVoiceChange = (
    state: LysStoreState,
    previousState: LysStoreState
  ): void => {
    if (state.voiceServerInfo !== previousState.voiceServerInfo) update()
  }
  const unsubscribeVoice = useLysStore.subscribe(onVoiceChange)
  const stopTrackingFocus = trackFocus((value) => {
    focused = value
    update(useChatViewStore.getState().request.status)
  })

  update()

  return () => {
    stopTrackingFocus()
    unsubscribeVoice()
    unsubscribeChat()
    controller.stop()
  }
}
