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

import { useChatViewStore, type ChatRequestState } from "@/lib/store/chat-view"
import type { ChatViewConversation } from "@/lib/store/chat-view/conversation-transitions"
import { useLysStore } from "@/lib/store"
import {
  SpeechController,
  type SpeechObservation,
  type SpeechReply
} from "./speech-controller"
import { createPcmPlayer } from "./pcm-player"

/**
 * Follows the window's focus: Tauri's window focus events, with a DOM
 * fallback for other shells.
 *
 * @param onChange - Called with the window's focus once it is first read and
 * on every change; never called after the cleanup ran.
 * @returns The cleanup, which stops following.
 * @remarks A throw from `onChange` after the first read, or from removing a
 * focus listener that registered after the cleanup, goes to the platform's
 * `reportError`, as an uncaught error does, since the desktop has no logger.
 * A window that cannot report its focus leaves `onChange` uncalled, and the
 * caller's default stands.
 */
function followWindowFocus(onChange: (focused: boolean) => void): () => void {
  try {
    const currentWindow = getCurrentWindow()
    let unlisten: (() => void) | undefined
    let disposed = false
    const sendFocus = (focused: boolean): void => {
      if (!disposed) onChange(focused)
    }
    // Only the window's own rejection means unknown focus; a throw from
    // `onChange` goes on to `reportError`.
    currentWindow
      .isFocused()
      .then(sendFocus, () => {
        // The window never reported; the default stands.
      })
      .catch((error: unknown) => {
        reportError(error)
      })
    const handleFocusListenerRegistered = (unlistenFocus: () => void): void => {
      if (disposed) unlistenFocus()
      else unlisten = unlistenFocus
    }
    currentWindow
      .onFocusChanged(({ payload }) => {
        sendFocus(payload)
      })
      .then(handleFocusListenerRegistered, () => {
        // Focus events are unavailable; focus stays at its last value.
      })
      // A throw from removing a listener that registered after the cleanup.
      .catch((error: unknown) => {
        reportError(error)
      })
    return () => {
      disposed = true
      unlisten?.()
    }
  } catch {
    const handleWindowFocus = () => {
      onChange(true)
    }
    const handleWindowBlur = () => {
      onChange(false)
    }
    window.addEventListener("focus", handleWindowFocus)
    window.addEventListener("blur", handleWindowBlur)
    return () => {
      window.removeEventListener("focus", handleWindowFocus)
      window.removeEventListener("blur", handleWindowBlur)
    }
  }
}

/**
 * Reads the backend's base as a WebSocket origin.
 *
 * @returns The backend URL with `http` replaced by `ws`.
 */
function buildWebSocketOrigin(): string {
  return useLysStore.getState().backendUrl.replace(/^http/, "ws")
}

/**
 * Fills a speech route's path parameters with a reply's identifiers.
 *
 * @param template - Route path with `:conversationId` and
 * `:assistantMessageId`.
 * @param reply - The reply the socket speaks for.
 * @param query - Query string without its `?`, if any.
 * @returns The path, with the query appended.
 */
function buildSpeechRoutePath(
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
 * @returns `streaming` while the shown conversation's reply streams,
 * `settled` once it reached a final state, also after the request that
 * followed it ended, and `none` otherwise.
 */
function buildObservation(
  previousRequestStatus: ChatRequestState["status"] | undefined
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
  if (request.status === "idle") return buildLastReplyObservation(conversation)
  return { kind: "none" }
}

/**
 * Reads the shown conversation's last reply while no request follows one,
 * so a completed reply still being said plays out after its stream ended.
 *
 * @param conversation - The shown conversation.
 * @returns `settled` when its last message is a reply in a final state, and
 * `none` otherwise.
 */
function buildLastReplyObservation(
  conversation: ChatViewConversation
): SpeechObservation {
  const last = conversation.messages.at(-1)
  if (last?.role !== "assistant" || last.status === "streaming")
    return { kind: "none" }
  return {
    kind: "settled",
    reply: { conversationId: conversation.id, replyId: last.id },
    status: last.status
  }
}

/**
 * Passes one binary WebSocket message to the handler, if it is one.
 *
 * @param event - The message event the socket received.
 * @param handlers - The controller's socket handlers.
 */
function sendBinaryFrame(
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
 * @returns A cleanup that stops following the stores and the window's focus,
 * and closes the controller with its sockets and audio context.
 * @remarks Idempotent within one call only: callers must call the returned
 * cleanup rather than start twice.
 */
export function startSpeech(): () => void {
  const isVoiceReady = (): boolean =>
    useLysStore.getState().voiceServerInfo.status === "running"
  const updateVoiceServerInfo = (): void => {
    void useLysStore.getState().updateVoiceServerInfo()
  }

  let focused = true
  const controller = new SpeechController({
    isFocused: () => focused,
    isVoiceReady,
    buildSpeechPath: (reply, from) =>
      buildSpeechRoutePath(chatSpeechApi.path, reply, `from=${from}`),
    buildNotificationPath: (reply) =>
      buildSpeechRoutePath(chatNotificationApi.path, reply),
    openSocket: (path, handlers) => {
      const socket = new WebSocket(`${buildWebSocketOrigin()}${path}`)
      socket.binaryType = "arraybuffer"
      socket.addEventListener("message", (event) => {
        sendBinaryFrame(event, handlers)
      })
      socket.addEventListener("close", (event) => {
        handlers.onClose(event.code)
      })
      // The error is followed by a close; nothing more to do here.
      return { close: () => socket.close() }
    },
    createPlayer: () => createPcmPlayer(),
    updateVoiceServerInfo
  })

  const updateController = (
    previousRequestStatus?: ChatRequestState["status"]
  ): void => {
    controller.update(buildObservation(previousRequestStatus))
  }

  const stopFollowingChat = useChatViewStore.subscribe(
    (_state, previousState) => {
      updateController(previousState.request.status)
    }
  )
  type LysStoreState = ReturnType<typeof useLysStore.getState>
  const handleVoiceChange = (
    state: LysStoreState,
    previousState: LysStoreState
  ): void => {
    if (state.voiceServerInfo !== previousState.voiceServerInfo)
      updateController()
  }
  const stopFollowingVoice = useLysStore.subscribe(handleVoiceChange)
  const stopFollowingFocus = followWindowFocus((value) => {
    focused = value
    updateController(useChatViewStore.getState().request.status)
  })

  updateController()

  return () => {
    stopFollowingFocus()
    stopFollowingVoice()
    stopFollowingChat()
    controller.close()
  }
}
