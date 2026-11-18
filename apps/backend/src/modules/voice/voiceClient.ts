import { VOICE_HOST, VOICE_PORT, VOICE_SOCKET_PORT } from "@lys/protocol"

/** How long the health check waits for voice before giving up, in milliseconds. */
const VOICE_HEALTH_TIMEOUT_MS = 2_000

/** How long a speech handshake waits for voice before giving up, in milliseconds. */
const VOICE_HANDSHAKE_TIMEOUT_MS = 2_000

/** URL of the voice health route. */
const VOICE_HEALTH_URL = `http://${VOICE_HOST}:${VOICE_PORT}/health`

/** URL of the voice speech WebSocket. */
const VOICE_SPEECH_URL = `ws://${VOICE_HOST}:${VOICE_SOCKET_PORT}`

/**
 * Asks voice whether it is ready to speak.
 *
 * @param fetchImpl - Fetch implementation to use; the global `fetch` unless
 * a test injects another.
 * @returns True when voice answered its health route with `200 OK` within
 * two seconds.
 * @remarks A stopped, starting, or broken voice answers anything else or
 * not at all; every failure reads as not ready.
 */
export async function isVoiceReady(
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  try {
    const response = await fetchImpl(VOICE_HEALTH_URL, {
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
  /** Tells voice to begin a speech, closing any older speech. */
  speak: () => void
  /** Queues one sentence for synthesis. */
  speakText: (text: string) => void
  /** Signals that no more text follows; voice closes the socket when done. */
  finish: () => void
  /** Hangs up, cancelling the speech; idempotent. */
  cancel: () => void
}>

/**
 * Failure of a speech handshake that voice refused, closed, or did not
 * answer in time.
 *
 * @remarks Passive failure value constructed once per failed handshake; the
 * caller tells it from any other failure by its class.
 */
export class VoiceUnavailableError extends Error {
  /**
   * Creates the failure of one handshake.
   *
   * @param message - What went wrong, for the log.
   */
  public constructor(message: string) {
    super(message)
    this.name = "VoiceUnavailableError"
  }
}

/**
 * Forwards one binary frame from voice to the listener.
 *
 * @param handlers - Listener for the frame's bytes.
 * @param data - Raw frame payload, in any binary wrapping; text frames are
 * ignored.
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
 * Drives one handshake with voice from dial to settlement, then relays the
 * socket's frames and close.
 *
 * @remarks Lifecycle: dials in the constructor; `completion` settles once,
 * with the speech when voice accepts, or with a {@link VoiceUnavailableError}
 * when voice refuses, closes, or does not answer within two seconds, in
 * which case the socket is closed. After acceptance every binary frame goes
 * to `onAudio` and the close to `onClose`. Concurrency model: single-owner,
 * on the backend's event loop.
 */
class VoiceHandshake {
  /** Settles with the speech once voice accepts the handshake. */
  public readonly completion: Promise<VoiceSpeech>
  /** Listeners for the accepted speech's frames and close. */
  readonly #handlers: VoiceSpeechHandlers
  /** Socket to voice, owned until the speech is handed out. */
  readonly #socket: WebSocket
  /** Settles {@link completion} once. */
  readonly #settlement = Promise.withResolvers<VoiceSpeech>()
  /** Gives up on a handshake voice does not answer. */
  readonly #timeout: ReturnType<typeof setTimeout>
  /** `dialing` until voice answers, then `accepted` or `failed` for good. */
  #state: "dialing" | "accepted" | "failed" = "dialing"

  /**
   * Dials voice.
   *
   * @param handlers - Listeners for the accepted speech's frames and close.
   * @param url - Voice speech socket.
   */
  public constructor(handlers: VoiceSpeechHandlers, url: string) {
    this.#handlers = handlers
    this.completion = this.#settlement.promise
    this.#socket = new WebSocket(url)
    this.#socket.binaryType = "arraybuffer"
    this.#socket.addEventListener("open", this.#handleOpen)
    this.#socket.addEventListener("error", this.#handleError)
    this.#socket.addEventListener("message", this.#handleMessage)
    this.#socket.addEventListener("close", this.#handleClose)
    this.#timeout = setTimeout(this.#handleTimeout, VOICE_HANDSHAKE_TIMEOUT_MS)
  }

  /** Hands out the speech once voice accepted the handshake. */
  readonly #handleOpen = (): void => {
    if (this.#state !== "dialing") return
    this.#state = "accepted"
    clearTimeout(this.#timeout)
    this.#settlement.resolve(createVoiceSpeech(this.#socket))
  }

  /** Fails a handshake the socket reported an error for. */
  readonly #handleError = (): void => {
    this.#fail("voice refused the connection")
  }

  /** Gives up on a handshake voice did not answer in time. */
  readonly #handleTimeout = (): void => {
    if (this.#state !== "dialing") return
    this.#fail("voice did not answer the connection in time")
    this.#socket.close()
  }

  /**
   * Relays one frame of the accepted speech.
   *
   * @param event - Message event of the voice socket.
   */
  readonly #handleMessage = (event: MessageEvent): void => {
    if (this.#state === "accepted")
      forwardAudioFrame(this.#handlers, event.data)
  }

  /**
   * Fails a handshake voice closed, or relays the close of the speech.
   *
   * @param event - Close event of the voice socket.
   */
  readonly #handleClose = (event: CloseEvent): void => {
    if (this.#state === "dialing")
      this.#fail("voice closed the connection before speaking")
    else if (this.#state === "accepted") this.#handlers.onClose(event.code)
  }

  /**
   * Fails a handshake still dialing; later calls do nothing.
   *
   * @param message - What went wrong, for the log.
   */
  #fail(message: string): void {
    if (this.#state !== "dialing") return
    this.#state = "failed"
    clearTimeout(this.#timeout)
    this.#settlement.reject(new VoiceUnavailableError(message))
  }
}

/**
 * Opens one speech connection to voice.
 *
 * @param handlers - Callbacks for audio frames and for the close.
 * @param url - Voice speech socket; voice's own unless a test passes another.
 * @returns The open speech, once voice accepted the handshake.
 * @throws {VoiceUnavailableError} If voice refuses or closes the handshake,
 * or does not answer it within two seconds.
 */
export function connectVoiceSpeech(
  handlers: VoiceSpeechHandlers,
  url: string = VOICE_SPEECH_URL
): Promise<VoiceSpeech> {
  return new VoiceHandshake(handlers, url).completion
}

/**
 * Wraps an open WebSocket to voice as a {@link VoiceSpeech}.
 *
 * @param socket - Open socket to voice; the speech owns it from now on.
 * @returns The speech; its messages are dropped once the socket stops being
 * open.
 */
function createVoiceSpeech(socket: WebSocket): VoiceSpeech {
  const send = (message: object): void => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
  }
  return Object.freeze({
    speak: () => send({ type: "speak" }),
    speakText: (text: string) => send({ type: "text", text }),
    finish: () => send({ type: "finish" }),
    cancel: () => {
      if (socket.readyState === socket.OPEN) socket.close()
    }
  })
}
