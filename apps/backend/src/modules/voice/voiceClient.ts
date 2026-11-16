import { VOICE_HOST, VOICE_PORT, VOICE_SOCKET_PORT } from "@lys/protocol"

/** How long the health check waits for voice before giving up. */
const VOICE_HEALTH_TIMEOUT_MS = 2_000

/** URL of the voice health route. */
export const voiceHealthUrl = `http://${VOICE_HOST}:${VOICE_PORT}/health`

/** URL of the voice speech WebSocket. */
export const voiceSpeechUrl = `ws://${VOICE_HOST}:${VOICE_SOCKET_PORT}`

/**
 * Asks voice whether it is ready to speak.
 *
 * @param fetchImpl - Fetch implementation to use, injected in tests.
 * @returns True when voice answered its health route with `200 OK`.
 * @remarks A stopped, starting, or broken voice answers anything else or
 * not at all; every failure reads as not ready.
 */
export async function isVoiceReady(
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  try {
    const response = await fetchImpl(voiceHealthUrl, {
      signal: AbortSignal.timeout(VOICE_HEALTH_TIMEOUT_MS)
    })
    return response.status === 200
  } catch {
    return false
  }
}

/** Handlers for one speech connection's events. */
export type VoiceSpeechHandlers = Readonly<{
  /** Called for each binary frame voice sends, with the raw PCM bytes. */
  onAudio: (pcm: Buffer) => void
  /** Called once when the voice socket closes, with its close code. */
  onClose: (code: number) => void
}>

/** One speech with the voice service, from the backend's point of view. */
export type VoiceSpeech = Readonly<{
  /** Tells voice to begin a speech; closing any older speech. */
  speak: () => void
  /** Queues one sentence for synthesis. */
  speakText: (text: string) => void
  /** Signals that no more text follows; voice closes the socket when done. */
  finish: () => void
  /** Hangs up, cancelling the speech. */
  cancel: () => void
  /** Bytes queued on the socket waiting to be written. */
  readonly bufferedAmount: number
}>

/**
 * The error raised when voice cannot be reached or refuses the connection.
 */
export class VoiceUnavailableError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = "VoiceUnavailableError"
  }
}

/**
 * Buffers one binary frame from voice towards the listener.
 *
 * @param handlers - Listener for the decoded frame.
 * @param data - Raw frame payload, in any binary wrapping.
 */
function forwardAudioFrame(handlers: VoiceSpeechHandlers, data: unknown): void {
  if (Buffer.isBuffer(data)) {
    handlers.onAudio(data)
    return
  }
  if (data instanceof ArrayBuffer) {
    handlers.onAudio(Buffer.from(new Uint8Array(data)))
    return
  }
  if (ArrayBuffer.isView(data)) {
    handlers.onAudio(Buffer.from(data.buffer, data.byteOffset, data.byteLength))
  }
}

/**
 * Drives one handshake with voice from dial to settlement.
 */
class VoiceHandshake {
  /** Settles with the speech once voice accepts the handshake. */
  public readonly completion: Promise<VoiceSpeech>
  readonly #handlers: VoiceSpeechHandlers
  readonly #socket: WebSocket
  #settled = false
  #resolve!: (speech: VoiceSpeech) => void
  #reject!: (error: Error) => void

  public constructor(handlers: VoiceSpeechHandlers, url: string) {
    this.#handlers = handlers
    this.#socket = new WebSocket(url)
    this.#socket.binaryType = "arraybuffer"
    this.completion = new Promise((resolve, reject) => {
      this.#resolve = resolve
      this.#reject = reject
    })
    this.#socket.addEventListener("open", this.#handleOpen)
    this.#socket.addEventListener("error", this.#handleError)
    this.#socket.addEventListener("message", this.#handleMessage)
    this.#socket.addEventListener("close", this.#handleClose)
  }

  readonly #handleOpen = (): void => {
    if (this.#settled) return
    this.#settled = true
    this.#resolve(createVoiceSpeech(this.#socket))
  }

  readonly #handleError = (): void => {
    if (this.#settled) return
    this.#settled = true
    this.#reject(new VoiceUnavailableError("voice refused the connection"))
  }

  readonly #handleMessage = (event: MessageEvent): void => {
    forwardAudioFrame(this.#handlers, event.data as unknown)
  }

  readonly #handleClose = (event: CloseEvent): void => {
    if (!this.#settled) {
      this.#settled = true
      this.#reject(
        new VoiceUnavailableError("voice closed the connection before speaking")
      )
      return
    }
    this.#handlers.onClose(event.code)
  }
}

/**
 * Opens one speech connection to voice.
 *
 * @param handlers - Callbacks for audio frames and for the close.
 * @param url - Voice speech socket; defaults to the protocol constant.
 * @returns The open speech, once voice accepted the handshake.
 * @throws {VoiceUnavailableError} If the handshake fails or times out.
 */
export function connectVoiceSpeech(
  handlers: VoiceSpeechHandlers,
  url: string = voiceSpeechUrl
): Promise<VoiceSpeech> {
  return new VoiceHandshake(handlers, url).completion
}

/** Wraps an open WebSocket as a {@link VoiceSpeech}. */
function createVoiceSpeech(socket: WebSocket): VoiceSpeech {
  const send = (message: object): void => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
  }
  return Object.freeze({
    speak: () => send({ type: "speak" }),
    speakText: (text: string) => send({ type: "text", text }),
    finish: () => send({ type: "finish" }),
    cancel: () => {
      try {
        socket.close()
      } catch {
        // The socket is already closing; nothing left to cancel.
      }
    },
    get bufferedAmount(): number {
      return socket.bufferedAmount
    }
  })
}
