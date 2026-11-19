import {
  DICTATION_AUDIO_SAMPLE_RATE_HZ,
  DICTATION_CLOSE_COMPLETE,
  DICTATION_CLOSE_FAILED,
  DICTATION_CLOSE_PROTOCOL_ERROR,
  DICTATION_CLOSE_VOICE_UNAVAILABLE,
  DICTATION_MAX_DURATION_MS,
  dictationClientMessageSchema,
  dictationServerMessageSchema,
  VOICE_AUDIO_BYTES_PER_SAMPLE,
  type DictationClientMessage,
  type DictationServerMessage
} from "@lys/protocol"
import type { FastifyBaseLogger } from "fastify"
import type { RawData, WebSocket } from "ws"
import type { SingleSocketRegistry } from "./singleSocketRegistry"
import {
  VOICE_CLOSE_COMPLETE,
  VoiceUnavailableError,
  type openVoiceDictation,
  type VoiceDictation
} from "./voiceClient"

/**
 * How many bytes of audio may wait for voice to accept the dictation: five
 * seconds of it, which is longer than the health check and the handshake
 * may take together.
 */
const MAX_PENDING_AUDIO_BYTES =
  5 * DICTATION_AUDIO_SAMPLE_RATE_HZ * VOICE_AUDIO_BYTES_PER_SAMPLE

/**
 * How many unsent bytes may wait for a slow socket, voice's or the UI's,
 * before the dictation fails. Towards voice this is about thirty seconds of
 * audio.
 */
const MAX_BUFFERED_BYTES = 1_000_000

/** How long voice has to send the final text after `stop`, in milliseconds. */
const FINAL_TEXT_TIMEOUT_MS = 10_000

/** Dependencies the dictation connection borrows. */
export type DictationConnectionDependencies = Readonly<{
  /** Holds the one socket that may dictate and supersedes older ones. */
  registry: SingleSocketRegistry
  /**
   * Asks voice whether it can listen; resolves `false` for a stopped,
   * starting, or broken voice and never rejects.
   */
  isReady: () => Promise<boolean>
  /** Opens one dictation at voice. */
  openVoiceDictation: typeof openVoiceDictation
}>

/** What one dictation socket connection needs. */
export type DictationConnectionOptions = Readonly<{
  /** The socket the UI opened on the dictation endpoint. */
  socket: WebSocket
  /** Borrowed dependencies. */
  deps: DictationConnectionDependencies
  /** Logger of the request that opened the socket. */
  log: FastifyBaseLogger
}>

/**
 * Relays one dictation between a socket the UI opened and voice.
 *
 * @param options - The socket, the dependencies, and the request's logger.
 * @returns Settlement once the dictation is connected to voice, or once the
 * socket was closed without one; it never rejects.
 * @remarks Closes the socket with the code the UI understands: the final
 * text was sent (`1000`), the client sent a text message that is not `stop`
 * or audio that is empty or not whole samples (`1002`), voice is not ready
 * or refused the handshake (`4503`), or the dictation failed (`1011`): the
 * handshake with voice failed for another reason than a refusal, voice
 * failed, broke the protocol, or sent no final text in time, or more audio
 * waited for voice, or more text for the UI, than the relay holds. A newer
 * dictation socket closes this one with `4409` first. The socket's
 * messages are read from the moment it opens, so audio sent while voice is
 * asked and dialed waits in order. A socket closed before voice answers
 * starts no dictation, and one closed later cancels its dictation at voice.
 * The socket's opening, its close code, and every failure are logged;
 * neither audio nor text ever is.
 */
export async function handleDictationConnection(
  options: DictationConnectionOptions
): Promise<void> {
  const { socket, deps, log } = options
  deps.registry.register(socket)
  const relay = new DictationRelay(socket, log)
  relay.start()
  socket.on("close", (code: number) => {
    deps.registry.remove(socket)
    log.info({ code }, "Dictation socket closed")
  })
  socket.on("error", (error: Error) => {
    log.warn({ err: error }, "Dictation socket failed")
  })
  log.info("Dictation socket opened")

  const isReady = await deps.isReady()
  if (!isOpen(socket)) return
  if (!isReady) {
    socket.close(DICTATION_CLOSE_VOICE_UNAVAILABLE)
    return
  }
  await relay.openVoice(deps.openVoiceDictation)
}

/**
 * Tells whether a socket still accepts messages.
 *
 * @param socket - The UI's socket.
 * @returns Whether it is open, not closing or closed.
 */
function isOpen(socket: WebSocket): boolean {
  return socket.readyState === socket.OPEN
}

/**
 * Reads a message of the UI's socket as one buffer.
 *
 * @param data - The message as `ws` delivers it.
 * @returns Its bytes; a message that arrived in fragments is joined.
 */
function buildMessageBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}

/**
 * Parses JSON text a peer sent.
 *
 * @param text - Text of one message.
 * @returns The parsed value, or undefined when the text is not JSON.
 */
function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Parses the text message a client may send on a dictation socket.
 *
 * @param text - Text of one client message.
 * @returns The `stop` message, or undefined for anything else.
 */
function parseClientMessage(text: string): DictationClientMessage | undefined {
  return dictationClientMessageSchema.safeParse(parseJsonText(text)).data
}

/**
 * Parses a text message voice sent on a dictation.
 *
 * @param text - Text of one message of voice.
 * @returns The `partial` or `final` message, or undefined for anything else.
 */
function parseVoiceMessage(text: string): DictationServerMessage | undefined {
  return dictationServerMessageSchema.safeParse(parseJsonText(text)).data
}

/** A relay whose dictation voice has not accepted yet. */
type ConnectingRelay = {
  readonly phase: "connecting"
  /** Audio received so far, in order. */
  readonly pendingAudio: Buffer[]
  /** Bytes held in `pendingAudio`. */
  pendingBytes: number
  /** Whether the dictation was stopped already; later audio is dropped. */
  isStopRequested: boolean
}

/**
 * Where one relay stands: `connecting` until voice accepted the dictation,
 * `listening` while audio is relayed, `stopping` once `stop` was sent to
 * voice, `finished` once the final text was relayed, and `closed` for good.
 */
type RelayState =
  | ConnectingRelay
  | Readonly<{
      phase: "listening" | "stopping" | "finished"
      /** The dictation at voice. */
      voice: VoiceDictation
    }>
  | Readonly<{ phase: "closed" }>

/**
 * Answers whether a message of audio carries one or more whole samples.
 *
 * @param pcm - Audio the UI sent.
 * @returns False for an empty message and for one that ends inside a sample.
 */
function hasWholeSamples(pcm: Buffer): boolean {
  return (
    pcm.byteLength > 0 && pcm.byteLength % VOICE_AUDIO_BYTES_PER_SAMPLE === 0
  )
}

/**
 * Adds audio to the audio waiting for voice, unless the wait is full.
 *
 * @param state - The connecting relay's state; its pending audio grows.
 * @param pcm - Audio the UI sent.
 * @returns False when the audio would exceed the bound, and was not added.
 */
function offerPendingAudio(state: ConnectingRelay, pcm: Buffer): boolean {
  if (state.pendingBytes + pcm.byteLength > MAX_PENDING_AUDIO_BYTES)
    return false
  state.pendingAudio.push(pcm)
  state.pendingBytes += pcm.byteLength
  return true
}

/**
 * Owns one dictation from the UI's first message to the close: the audio
 * flowing to voice, the text flowing back, and the end of the dictation.
 *
 * @remarks Lifecycle: `start` reads the socket's messages at once and
 * starts the time limit; `openVoice` dials voice and hands it the audio
 * that waited. The dictation stops when the UI sends `stop` or the time
 * limit passes: `stop` goes to voice, later audio is dropped, and voice has
 * ten seconds to send the final text. The relay ends when the socket
 * closes, from either side, which cancels the dictation at voice.
 * Concurrency model: single-owner, on the backend's event loop.
 */
class DictationRelay {
  /** The UI's socket; borrowed, and closed with the outcome's code. */
  readonly #socket: WebSocket
  /** Logger of the request that opened the socket. */
  readonly #log: FastifyBaseLogger
  /** Where the relay stands. */
  #state: RelayState = {
    phase: "connecting",
    pendingAudio: [],
    pendingBytes: 0,
    isStopRequested: false
  }
  /** Stops a dictation that reached its time limit. */
  #limitTimer: ReturnType<typeof setTimeout> | undefined
  /** Fails a dictation whose final text voice does not send. */
  #finalTextTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * Creates a relay that reads nothing yet.
   *
   * @param socket - The UI's socket.
   * @param log - Logger of the request that opened the socket.
   */
  public constructor(socket: WebSocket, log: FastifyBaseLogger) {
    this.#socket = socket
    this.#log = log
  }

  /**
   * Reads the socket's messages from now on and starts the time limit.
   *
   * @remarks Must be called in the same synchronous step that received the
   * socket, so that no message is missed.
   */
  public start(): void {
    this.#socket.on("message", (data: RawData, isBinary: boolean) => {
      this.#handleClientMessage(buildMessageBuffer(data), isBinary)
    })
    this.#socket.on("close", () => this.#closeRelay())
    this.#limitTimer = setTimeout(() => {
      this.#log.info("Dictation reached its time limit")
      this.#stopDictation()
    }, DICTATION_MAX_DURATION_MS)
  }

  /**
   * Dials voice and hands it the dictation and the audio that waited.
   *
   * @param open - Opens one dictation at voice.
   * @returns Settlement once voice has the dictation, or once the socket
   * was closed because voice refused or failed; it never rejects.
   */
  public async openVoice(open: typeof openVoiceDictation): Promise<void> {
    const voice = await this.#openDictationAtVoice(open)
    if (voice === undefined) return
    const state = this.#state
    if (state.phase !== "connecting" || !isOpen(this.#socket)) {
      voice.cancel()
      return
    }
    voice.start()
    for (const pcm of state.pendingAudio) voice.sendAudio(pcm)
    this.#state = { phase: "listening", voice }
    if (state.isStopRequested) this.#sendStop(voice)
  }

  /**
   * Opens the dictation at voice, closing the socket when voice refuses.
   *
   * @param open - Opens one dictation at voice.
   * @returns The dictation, or undefined once the socket was closed with
   * `4503` for a refused handshake or `1011` for any other failure.
   */
  async #openDictationAtVoice(
    open: typeof openVoiceDictation
  ): Promise<VoiceDictation | undefined> {
    try {
      return await open({
        onText: (text) => this.#handleVoiceText(text),
        onClose: (code) => this.#handleVoiceClose(code)
      })
    } catch (error) {
      const isRefused = error instanceof VoiceUnavailableError
      if (isRefused) this.#log.warn({ err: error }, "Voice refused a dictation")
      else this.#log.error({ err: error }, "Dictation could not reach voice")
      this.#closeSocket(
        isRefused ? DICTATION_CLOSE_VOICE_UNAVAILABLE : DICTATION_CLOSE_FAILED
      )
      return undefined
    }
  }

  /**
   * Routes one message of the UI: audio to voice, and `stop` to the stop.
   *
   * @param message - The message's bytes.
   * @param isBinary - Whether the message is binary, which is audio.
   * @remarks A message that arrives while the socket is closing, as after a
   * newer dictation superseded this one, is dropped.
   */
  #handleClientMessage(message: Buffer, isBinary: boolean): void {
    if (!isOpen(this.#socket)) return
    if (isBinary) {
      this.#handleClientAudio(message)
      return
    }
    if (parseClientMessage(message.toString("utf8")) === undefined) {
      this.#log.warn("Dictation socket sent a text message that is not stop")
      this.#closeSocket(DICTATION_CLOSE_PROTOCOL_ERROR)
      return
    }
    this.#stopDictation()
  }

  /**
   * Hands audio to voice, or keeps it until voice accepted the dictation;
   * audio after the stop is dropped.
   *
   * @param pcm - Audio the UI sent.
   * @remarks Audio that is empty or not whole samples closes the socket
   * with `1002` and never reaches voice, which reads an empty message as a
   * connection that went away.
   */
  #handleClientAudio(pcm: Buffer): void {
    const state = this.#state
    if (!hasWholeSamples(pcm)) {
      this.#log.warn(
        "Dictation socket sent audio that is empty or not whole samples"
      )
      this.#closeSocket(DICTATION_CLOSE_PROTOCOL_ERROR)
      return
    }
    if (state.phase === "connecting") {
      if (state.isStopRequested || offerPendingAudio(state, pcm)) return
      this.#log.warn("Dictation audio waited too long for voice")
      this.#closeSocket(DICTATION_CLOSE_FAILED)
      return
    }
    if (state.phase !== "listening") return
    const bufferedBytes = state.voice.getBufferedBytes()
    if (bufferedBytes > MAX_BUFFERED_BYTES) {
      this.#log.warn({ bufferedBytes }, "Voice fell behind a dictation's audio")
      this.#closeSocket(DICTATION_CLOSE_FAILED)
      return
    }
    state.voice.sendAudio(pcm)
  }

  /**
   * Stops the dictation: at once when voice has it, and as soon as voice
   * accepted it otherwise. A second stop does nothing.
   */
  #stopDictation(): void {
    const state = this.#state
    if (state.phase === "connecting") state.isStopRequested = true
    if (state.phase === "listening") this.#sendStop(state.voice)
  }

  /**
   * Tells voice no more audio follows and starts the wait for the final
   * text.
   *
   * @param voice - The dictation at voice.
   */
  #sendStop(voice: VoiceDictation): void {
    clearTimeout(this.#limitTimer)
    this.#state = { phase: "stopping", voice }
    voice.sendStop()
    this.#finalTextTimer = setTimeout(() => {
      this.#log.warn("Voice sent no final text in time")
      this.#closeSocket(DICTATION_CLOSE_FAILED)
    }, FINAL_TEXT_TIMEOUT_MS)
  }

  /**
   * Relays one text message of voice to the UI, once validated.
   *
   * @param text - Text of the message, unvalidated.
   * @remarks A message that is not a dictation message, a final text nobody
   * asked for, and a UI that fell too far behind each fail the dictation.
   */
  #handleVoiceText(text: string): void {
    const state = this.#state
    if (state.phase !== "listening" && state.phase !== "stopping") return
    if (!isOpen(this.#socket)) return
    const message = parseVoiceMessage(text)
    if (message === undefined) {
      this.#log.error("Voice sent a message that is not a dictation message")
      this.#closeSocket(DICTATION_CLOSE_FAILED)
      return
    }
    if (message.type === "final" && state.phase === "listening") {
      this.#log.error("Voice sent a final text before the dictation stopped")
      this.#closeSocket(DICTATION_CLOSE_FAILED)
      return
    }
    const bufferedBytes = this.#socket.bufferedAmount
    if (bufferedBytes > MAX_BUFFERED_BYTES) {
      this.#log.warn({ bufferedBytes }, "Dictation socket fell behind its text")
      this.#closeSocket(DICTATION_CLOSE_FAILED)
      return
    }
    this.#socket.send(JSON.stringify(message))
    if (message.type !== "final") return
    clearTimeout(this.#finalTextTimer)
    this.#state = { phase: "finished", voice: state.voice }
  }

  /**
   * Relays voice's close of the dictation to the UI's socket.
   *
   * @param code - Voice's close code; `1000` once the final text was sent.
   * @remarks A close that follows the UI's socket closing, as when voice
   * retires the dictation a newer one superseded, is not a failure.
   */
  #handleVoiceClose(code: number): void {
    if (!isOpen(this.#socket)) return
    if (code === VOICE_CLOSE_COMPLETE && this.#state.phase === "finished") {
      this.#closeSocket(DICTATION_CLOSE_COMPLETE)
      return
    }
    this.#log.warn(
      { voiceCloseCode: code },
      "Voice ended a dictation that failed"
    )
    this.#closeSocket(DICTATION_CLOSE_FAILED)
  }

  /**
   * Ends the relay and closes the UI's socket with the outcome's code.
   *
   * @param code - Close code the UI reads.
   */
  #closeSocket(code: number): void {
    this.#closeRelay()
    if (isOpen(this.#socket)) this.#socket.close(code)
  }

  /**
   * Ends the relay: stops both timers, forgets the audio that waited, and
   * cancels the dictation at voice. A second call does nothing.
   */
  #closeRelay(): void {
    const state = this.#state
    this.#state = { phase: "closed" }
    clearTimeout(this.#limitTimer)
    clearTimeout(this.#finalTextTimer)
    if (state.phase !== "connecting" && state.phase !== "closed")
      state.voice.cancel()
  }
}
