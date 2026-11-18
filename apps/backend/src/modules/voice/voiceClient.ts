import { VOICE_HOST, VOICE_PORT, VOICE_SOCKET_PORT } from "@lys/protocol"

/** How long the health check waits for voice before giving up, in milliseconds. */
const VOICE_HEALTH_TIMEOUT_MS = 2_000

/** How long a socket handshake waits for voice before giving up, in milliseconds. */
const VOICE_HANDSHAKE_TIMEOUT_MS = 2_000

/** URL of the voice health route. */
const VOICE_HEALTH_URL = `http://${VOICE_HOST}:${VOICE_PORT}/health`

/** URL of voice's WebSocket, which serves speeches and dictations. */
const VOICE_SOCKET_URL = `ws://${VOICE_HOST}:${VOICE_SOCKET_PORT}`

/**
 * Asks voice whether it is ready to speak and to listen.
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
  start: () => void
  /** Queues one sentence for synthesis. */
  sendText: (text: string) => void
  /** Signals that no more text follows; voice closes the socket when done. */
  sendFinish: () => void
  /** Hangs up, cancelling the speech; idempotent. */
  cancel: () => void
}>

/** Handlers for one dictation connection's events. */
export type VoiceDictationHandlers = Readonly<{
  /** Called for each text frame voice sends, with its text, unvalidated. */
  onText: (text: string) => void
  /** Called once when the voice socket closes, with its close code. */
  onClose: (code: number) => void
}>

/** One dictation with the voice service, from the backend's point of view. */
export type VoiceDictation = Readonly<{
  /** Tells voice to begin a dictation, closing any older dictation. */
  start: () => void
  /** Sends audio to hear: 16 kHz mono 16-bit PCM, whole samples. */
  sendAudio: (pcm: Uint8Array) => void
  /** Signals that no more audio follows; voice answers with the final text. */
  sendStop: () => void
  /** Counts the bytes sent that voice has not taken yet. */
  getBufferedBytes: () => number
  /** Hangs up, cancelling the dictation; idempotent. */
  cancel: () => void
}>

/**
 * Failure of a socket handshake that voice refused, closed, or did not
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
function sendAudioFrame(handlers: VoiceSpeechHandlers, data: unknown): void {
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

/** What one handshake with voice needs. */
type VoiceHandshakeOptions<Job> = Readonly<{
  /** Voice's socket. */
  url: string
  /** Wraps the accepted socket as the job handed out. */
  createJob: (socket: WebSocket) => Job
  /** Called for each frame of the accepted socket, with its payload. */
  onMessage: (data: unknown) => void
  /** Called once when the accepted socket closes, with its close code. */
  onClose: (code: number) => void
}>

/**
 * Drives one handshake with voice from dial to settlement, then relays the
 * socket's frames and close.
 *
 * @typeParam Job - The speech or the dictation handed out once voice
 * accepted.
 * @remarks Lifecycle: dials in the constructor; `completion` settles once,
 * with the job when voice accepts, or with a {@link VoiceUnavailableError}
 * when voice refuses, closes, or does not answer within two seconds, in
 * which case the socket is closed. After acceptance every frame goes to
 * `onMessage` and the close to `onClose`. Concurrency model: single-owner,
 * on the backend's event loop.
 */
class VoiceHandshake<Job> {
  /** Settles with the job once voice accepts the handshake. */
  public readonly completion: Promise<Job>
  /** The job's maker and the listeners for its frames and close. */
  readonly #options: VoiceHandshakeOptions<Job>
  /** Socket to voice, owned until the job is handed out. */
  readonly #socket: WebSocket
  /** Settles {@link completion} once. */
  readonly #settlement = Promise.withResolvers<Job>()
  /** Gives up on a handshake voice does not answer. */
  readonly #timeout: ReturnType<typeof setTimeout>
  /** `dialing` until voice answers, then `accepted` or `failed` for good. */
  #state: "dialing" | "accepted" | "failed" = "dialing"

  /**
   * Dials voice.
   *
   * @param options - Voice's socket, the job's maker, and the listeners for
   * the accepted socket's frames and close.
   */
  public constructor(options: VoiceHandshakeOptions<Job>) {
    this.#options = options
    this.completion = this.#settlement.promise
    this.#socket = new WebSocket(options.url)
    this.#socket.binaryType = "arraybuffer"
    this.#socket.addEventListener("open", this.#handleOpen)
    this.#socket.addEventListener("error", this.#handleError)
    this.#socket.addEventListener("message", this.#handleMessage)
    this.#socket.addEventListener("close", this.#handleClose)
    this.#timeout = setTimeout(this.#handleTimeout, VOICE_HANDSHAKE_TIMEOUT_MS)
  }

  /** Hands out the job once voice accepted the handshake. */
  readonly #handleOpen = (): void => {
    if (this.#state !== "dialing") return
    this.#state = "accepted"
    clearTimeout(this.#timeout)
    this.#settlement.resolve(this.#options.createJob(this.#socket))
  }

  /** Fails a handshake the socket reported an error for. */
  readonly #handleError = (): void => {
    this.#rejectHandshake("voice refused the connection")
  }

  /** Gives up on a handshake voice did not answer in time. */
  readonly #handleTimeout = (): void => {
    if (this.#state !== "dialing") return
    this.#rejectHandshake("voice did not answer the connection in time")
    this.#socket.close()
  }

  /**
   * Relays one frame of the accepted socket.
   *
   * @param event - Message event of the voice socket.
   */
  readonly #handleMessage = (event: MessageEvent): void => {
    if (this.#state === "accepted") this.#options.onMessage(event.data)
  }

  /**
   * Fails a handshake voice closed, or relays the close of the job.
   *
   * @param event - Close event of the voice socket.
   */
  readonly #handleClose = (event: CloseEvent): void => {
    if (this.#state === "dialing")
      this.#rejectHandshake("voice closed the connection before accepting it")
    else if (this.#state === "accepted") this.#options.onClose(event.code)
  }

  /**
   * Fails a handshake still dialing; later calls do nothing.
   *
   * @param message - What went wrong, for the log.
   */
  #rejectHandshake(message: string): void {
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
 * @param url - Voice's socket; voice's own unless a test passes another.
 * @returns The open speech, once voice accepted the handshake.
 * @throws {VoiceUnavailableError} If voice refuses or closes the handshake,
 * or does not answer it within two seconds.
 */
export function openVoiceSpeech(
  handlers: VoiceSpeechHandlers,
  url: string = VOICE_SOCKET_URL
): Promise<VoiceSpeech> {
  return new VoiceHandshake({
    url,
    createJob: createVoiceSpeech,
    onMessage: (data) => sendAudioFrame(handlers, data),
    onClose: handlers.onClose
  }).completion
}

/**
 * Opens one dictation connection to voice.
 *
 * @param handlers - Callbacks for text frames and for the close.
 * @param url - Voice's socket; voice's own unless a test passes another.
 * @returns The open dictation, once voice accepted the handshake. Its
 * binary frames, which voice never sends on a dictation, are ignored.
 * @throws {VoiceUnavailableError} If voice refuses or closes the handshake,
 * or does not answer it within two seconds.
 */
export function openVoiceDictation(
  handlers: VoiceDictationHandlers,
  url: string = VOICE_SOCKET_URL
): Promise<VoiceDictation> {
  return new VoiceHandshake({
    url,
    createJob: createVoiceDictation,
    onMessage: (data) => {
      if (typeof data === "string") handlers.onText(data)
    },
    onClose: handlers.onClose
  }).completion
}

/**
 * Wraps an open WebSocket to voice as a {@link VoiceSpeech}.
 *
 * @param socket - Open socket to voice; the speech owns it from now on.
 * @returns The speech; its messages are dropped once the socket stops being
 * open.
 */
function createVoiceSpeech(socket: WebSocket): VoiceSpeech {
  const sendMessage = (message: object): void => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
  }
  return Object.freeze({
    start: () => sendMessage({ type: "speak" }),
    sendText: (text: string) => sendMessage({ type: "text", text }),
    sendFinish: () => sendMessage({ type: "finish" }),
    cancel: () => {
      if (socket.readyState === socket.OPEN) socket.close()
    }
  })
}

/**
 * Wraps an open WebSocket to voice as a {@link VoiceDictation}.
 *
 * @param socket - Open socket to voice; the dictation owns it from now on.
 * @returns The dictation; its messages are dropped once the socket stops
 * being open.
 */
function createVoiceDictation(socket: WebSocket): VoiceDictation {
  const sendMessage = (message: string | Uint8Array): void => {
    if (socket.readyState === socket.OPEN) socket.send(message)
  }
  return Object.freeze({
    start: () => sendMessage(JSON.stringify({ type: "transcribe" })),
    sendAudio: (pcm: Uint8Array) => sendMessage(pcm),
    sendStop: () => sendMessage(JSON.stringify({ type: "stop" })),
    getBufferedBytes: () => socket.bufferedAmount,
    cancel: () => {
      if (socket.readyState === socket.OPEN) socket.close()
    }
  })
}
