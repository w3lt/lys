/**
 * Opens the backend's dictation WebSocket for the composer's dictation.
 *
 * @remarks The socket carries audio up and text down. Messages sent while
 * the socket is still connecting wait, in order, and are sent once it opens,
 * so a recording may start before the socket is open. Only so much audio
 * waits; the stop message always does, so a dictation whose socket opens
 * late still asks for its final text.
 */
import type {
  DictationSocket,
  DictationSocketHandlers
} from "./composer-dictation"

/** The message that asks for the final text. */
const STOP_MESSAGE = JSON.stringify({ type: "stop" })

/**
 * Most messages that may wait for the socket to open before a frame of
 * audio is dropped instead of waiting too, inclusive: five seconds of audio
 * at ten frames a second. The stop message waits whatever their number.
 */
const MAX_WAITING_MESSAGES = 50

/** A message of the dictation socket: the stop message, or a frame of audio. */
type DictationSocketMessage = string | Uint8Array<ArrayBuffer>

/**
 * Sends a message on a socket, or keeps it while the socket connects.
 *
 * @param socket - The platform's socket.
 * @param waiting - Messages that wait for the socket to open, in order.
 * @param message - The message.
 * @remarks A message for a socket that is closing or closed is dropped, as
 * is a frame of audio beyond the most that may wait. The stop message
 * always waits.
 */
function sendSocketMessage(
  socket: WebSocket,
  waiting: DictationSocketMessage[],
  message: DictationSocketMessage
): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(message)
  else if (socket.readyState !== WebSocket.CONNECTING) return
  else if (message === STOP_MESSAGE || waiting.length < MAX_WAITING_MESSAGES)
    waiting.push(message)
}

/**
 * Sends the messages that waited for a socket to open.
 *
 * @param socket - The platform's socket, now open.
 * @param waiting - Messages that waited, in order; emptied.
 */
function sendWaitingMessages(
  socket: WebSocket,
  waiting: DictationSocketMessage[]
): void {
  for (const message of waiting.splice(0)) socket.send(message)
}

/**
 * Passes one text message of the platform's socket to the handler.
 *
 * @param event - The message event the socket received.
 * @param handlers - The socket handlers of the composer's dictation.
 */
function sendTextMessage(
  event: MessageEvent<unknown>,
  handlers: DictationSocketHandlers
): void {
  if (typeof event.data === "string") handlers.onText(event.data)
}

/**
 * Opens one dictation socket.
 *
 * @param url - URL of the backend's dictation route, with the `ws` scheme.
 * @param handlers - Receive each text message and the close.
 * @returns The socket. A message sent while it connects waits for the open,
 * audio up to five seconds of it and the stop message always; one sent once
 * it is closing or closed is dropped.
 * @remarks A connection that fails is reported as a close, with the code the
 * platform gives it. Binary messages from the backend are ignored: a
 * dictation carries none.
 */
export function openDictationSocket(
  url: string,
  handlers: DictationSocketHandlers
): DictationSocket {
  const socket = new WebSocket(url)
  const waiting: DictationSocketMessage[] = []
  socket.addEventListener("open", () => {
    sendWaitingMessages(socket, waiting)
  })
  socket.addEventListener("message", (event: MessageEvent<unknown>) => {
    sendTextMessage(event, handlers)
  })
  socket.addEventListener("close", (event) => {
    handlers.onClose(event.code)
  })
  return Object.freeze({
    sendAudio: (frame: Uint8Array<ArrayBuffer>) => {
      sendSocketMessage(socket, waiting, frame)
    },
    sendStop: () => {
      sendSocketMessage(socket, waiting, STOP_MESSAGE)
    },
    close: () => {
      socket.close()
    }
  })
}
