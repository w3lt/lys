import {
  SPEECH_CLOSE_COMPLETE,
  SPEECH_CLOSE_FAILED,
  SPEECH_CLOSE_NO_SUCH_REPLY,
  SPEECH_CLOSE_REPLY_ENDED,
  SPEECH_CLOSE_SHUTDOWN,
  SPEECH_CLOSE_TOO_SLOW,
  SPEECH_CLOSE_VOICE_UNAVAILABLE
} from "@lys/protocol"
import type { ChatGenerationEvent } from "@lys/protocol"
import type { ConversationAssistantMessage } from "@lys/share"
import type { FastifyBaseLogger } from "fastify"
import type { WebSocket } from "ws"
import type ReplyGeneration from "../chat/replyGeneration"
import ReplyEventSubscription from "../chat/replyEventSubscription"
import type ReplyGenerationRegistry from "../chat/replyGenerationRegistry"
import { ReplyGenerationRegistryClosedError } from "../chat/replyGenerationRegistry"
import type { ConversationReader } from "../conversation/capabilities"
import type { SingleSocketRegistry } from "./singleSocketRegistry"
import {
  VoiceUnavailableError,
  type openVoiceSpeech,
  type VoiceSpeech
} from "./voiceClient"
import {
  SpeechSentenceBuffer,
  buildVoiceTextPieces,
  type SpeechSnapshot,
  type SpeechStart
} from "./speechText"

/**
 * How many unsent bytes may wait for a slow UI socket before the speech is
 * cut off. At 48 KB/s of audio this is about twenty seconds of speech.
 */
const MAX_BUFFERED_BYTES = 1_000_000

/** Close code voice ends a speech with once everything was spoken. */
const VOICE_CLOSE_COMPLETE = 1000

/** Which reply a speech socket speaks for. */
export type SpeechTarget = Readonly<{
  /** Conversation holding the reply. */
  conversationId: string
  /** The reply to speak. */
  assistantMessageId: string
}>

/** What the socket should speak. */
export type SpeechRequest =
  | Readonly<{
      kind: "reply"
      /**
       * `start` reads the reply from its first word; `current` starts at the
       * sentence being written and is refused when the reply is not being
       * written.
       */
      from: SpeechStart
    }>
  | Readonly<{
      kind: "notification"
      /** The line to speak, already chosen by the caller. */
      line: string
    }>

/** Dependencies the speech connection borrows. */
export type SpeechConnectionDependencies = Readonly<{
  /** Reads the stored reply the socket speaks. */
  history: ConversationReader
  /** Finds a running generation for the reply. */
  generations: ReplyGenerationRegistry
  /** Holds the one socket that may speak and supersedes older ones. */
  registry: SingleSocketRegistry
  /**
   * Asks voice whether it can speak; resolves `false` for a stopped,
   * starting, or broken voice and never rejects.
   */
  isReady: () => Promise<boolean>
  /** Opens one speech at voice. */
  openVoiceSpeech: typeof openVoiceSpeech
}>

/** What one speech socket connection needs. */
export type SpeechConnectionOptions = Readonly<{
  /** The socket the UI opened on the speech or notification endpoint. */
  socket: WebSocket
  /** Which conversation and reply the socket addresses. */
  target: SpeechTarget
  /** What to speak and from where. */
  request: SpeechRequest
  /** Borrowed dependencies. */
  deps: SpeechConnectionDependencies
  /** Logger of the request that opened the socket. */
  log: FastifyBaseLogger
}>

/**
 * Speaks one reply or one notification line onto a socket the UI opened.
 *
 * @param options - The socket, its target, what to speak, the dependencies,
 * and the request's logger.
 * @returns Settlement once the speech is connected to voice and speaks what
 * was stored, following the reply's generation while it runs, or once the
 * socket was closed without a speech.
 * @throws Only an unexpected failure of the generation registry; every
 * expected outcome closes the socket with its code instead.
 * @remarks Closes the socket with the code the UI understands: voice is not
 * ready (`4503`), the reply is missing (`4404`), the reply stopped or is not
 * being written when `from` is `current` (`4410`), the UI did not keep up
 * (`1008`), the reply could not be read (`1011`), the backend is shutting
 * down (`1001`), or voice's own outcome mapped to `1000` or `1011`. A newer
 * socket closes this one with `4409` first. Voice is asked first; the stored
 * reply is then read and its generation followed in one synchronous step,
 * so no fragment falls between the two. A socket closed before voice answers
 * starts no speech, and one closed later cancels its speech at voice. The
 * socket's opening, its close code, and every failure are logged.
 */
export async function handleSpeechConnection(
  options: SpeechConnectionOptions
): Promise<void> {
  const { socket, request, deps, log } = options
  deps.registry.register(socket)
  socket.on("close", (code: number) => {
    deps.registry.remove(socket)
    log.info({ code }, "Speech socket closed")
  })
  socket.on("error", (error: Error) => {
    log.warn({ err: error }, "Speech socket failed")
  })
  log.info(
    {
      speech: request.kind,
      from: request.kind === "reply" ? request.from : undefined
    },
    "Speech socket opened"
  )

  const isReady = await deps.isReady()
  if (!isOpen(socket)) return
  if (!isReady) {
    socket.close(SPEECH_CLOSE_VOICE_UNAVAILABLE)
    return
  }
  // The session must start in the same synchronous step that read the
  // stored reply, so that it follows every event the snapshot lacks.
  await openSession(options)?.start()
}

/** The stored reply a socket speaks, with its text parts split out. */
type StoredReply = Readonly<{
  /** The reply's text parts and whether its last round's text may grow. */
  snapshot: SpeechSnapshot
  /** Identifiers of the text parts, so streamed fragments can be matched. */
  textPartIds: ReadonlySet<string>
  /** Whether the stored reply is still streaming. */
  isStreaming: boolean
}>

/** Read outcome of the stored reply a socket speaks. */
type StoredReplyResult =
  | Readonly<{ kind: "found"; reply: StoredReply }>
  | Readonly<{ kind: "missing" }>
  | Readonly<{
      kind: "unreadable"
      /** What the conversation store threw. */
      cause: unknown
    }>

/**
 * Reads the stored reply and creates the session that speaks it, closing
 * the socket instead when nothing can be spoken.
 *
 * @param options - The connection's socket, target, request, dependencies,
 * and logger.
 * @returns The session, to start at once, or undefined once the socket was
 * closed with the reason's code.
 * @throws Only an unexpected failure of the generation registry.
 */
function openSession(
  options: SpeechConnectionOptions
): SpeechSession | undefined {
  const { socket, target, request, deps, log } = options
  const storedReply = readStoredReply(deps.history, target)
  if (storedReply.kind === "missing") {
    socket.close(SPEECH_CLOSE_NO_SUCH_REPLY)
    return undefined
  }
  if (storedReply.kind === "unreadable") {
    log.error({ err: storedReply.cause }, "Speech could not read the reply")
    socket.close(SPEECH_CLOSE_FAILED)
    return undefined
  }
  const stored = storedReply.reply
  let generation: ReplyGeneration | undefined
  try {
    generation =
      request.kind === "reply"
        ? findWritingGeneration(deps.generations, target, stored)
        : undefined
  } catch (error) {
    if (!(error instanceof ReplyGenerationRegistryClosedError)) throw error
    socket.close(SPEECH_CLOSE_SHUTDOWN)
    return undefined
  }
  if (
    request.kind === "reply" &&
    request.from === "current" &&
    generation === undefined
  ) {
    socket.close(SPEECH_CLOSE_REPLY_ENDED)
    return undefined
  }
  return new SpeechSession({
    socket,
    stored,
    generation,
    request,
    openVoiceSpeech: deps.openVoiceSpeech,
    log
  })
}

/**
 * Reads the stored reply a socket addresses.
 *
 * @param history - Reader of stored conversations.
 * @param target - The conversation and the reply.
 * @returns The reply's text parts, `missing` when the conversation or the
 * reply does not exist, or `unreadable` with what the store threw.
 */
function readStoredReply(
  history: ConversationReader,
  target: SpeechTarget
): StoredReplyResult {
  let conversation
  try {
    conversation = history.getConversation(target.conversationId)
  } catch (error) {
    return { kind: "unreadable", cause: error }
  }
  const message = conversation?.messages.find(
    (candidate): candidate is ConversationAssistantMessage =>
      candidate.role === "assistant" &&
      candidate.id === target.assistantMessageId
  )
  if (message === undefined) return { kind: "missing" }
  const textParts = message.parts.filter((part) => part.kind === "text")
  const isStreaming = message.status === "streaming"
  const lastTextIndex = message.parts.findLastIndex(
    (part) => part.kind === "text"
  )
  const hasRoundTextEnded = message.parts
    .slice(lastTextIndex + 1)
    .some((part) => part.kind === "tool-call")
  return {
    kind: "found",
    reply: Object.freeze({
      snapshot: Object.freeze({
        textParts: textParts.map(({ round, content }) => ({ round, content })),
        lastRoundText:
          isStreaming && lastTextIndex !== -1 && !hasRoundTextEnded
            ? "open"
            : "closed"
      }),
      textPartIds: new Set(textParts.map((part) => part.id)),
      isStreaming
    })
  }
}

/**
 * Finds the generation still writing a stored reply.
 *
 * @param generations - Registry of running generations.
 * @param target - The conversation and the reply.
 * @param stored - The reply as stored now.
 * @returns The generation, or undefined when none runs or the stored reply
 * already ended; a generation stays registered for an instant after its
 * reply ended, while the stored reply already says so.
 * @throws {ReplyGenerationRegistryClosedError} Once the backend began
 * shutting down.
 */
function findWritingGeneration(
  generations: ReplyGenerationRegistry,
  target: SpeechTarget,
  stored: StoredReply
): ReplyGeneration | undefined {
  const generation = generations.findReplyGeneration(target)
  return stored.isStreaming ? generation : undefined
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

/** What one speech session needs. */
type SpeechSessionOptions = Readonly<{
  /** The UI's socket. */
  socket: WebSocket
  /** The reply stored when the session was created. */
  stored: StoredReply
  /** The generation writing the reply, or undefined when it is over. */
  generation: ReplyGeneration | undefined
  /** What to speak and from where. */
  request: SpeechRequest
  /** Opens the speech at voice. */
  openVoiceSpeech: typeof openVoiceSpeech
  /** Logger of the request that opened the socket. */
  log: FastifyBaseLogger
}>

/**
 * Owns one speech from the voice connection to the close: what to speak, the
 * frames flowing from voice to the socket, and the end of the speech.
 *
 * @remarks Lifecycle: created once voice is ready and the reply was read;
 * `start` follows the reply's generation at once and then connects to
 * voice; the session ends when the socket closes. Events that arrive before
 * voice answers wait in order and are applied once it does. Closing the
 * socket, from either side, cancels the speech at voice and ends the
 * following. Concurrency model: single-owner, on the backend's event loop.
 */
class SpeechSession {
  /** The UI's socket; borrowed, and closed with the outcome's code. */
  readonly #socket: WebSocket
  /** The reply stored when the session was created. */
  readonly #stored: StoredReply
  /** The generation writing the reply, or undefined when it is over. */
  readonly #generation: ReplyGeneration | undefined
  /** What to speak and from where. */
  readonly #request: SpeechRequest
  /** Opens the speech at voice. */
  readonly #openVoiceSpeech: typeof openVoiceSpeech
  /** Logger of the request that opened the socket. */
  readonly #log: FastifyBaseLogger
  /** Hands out the sentences to speak; the snapshot seeds it. */
  readonly #buffer: SpeechSentenceBuffer
  /** Ids of the text parts seen so far; other parts are not spoken. */
  readonly #textPartIds: Set<string>
  /** Follows the generation's events for as long as the speech runs. */
  readonly #subscription: ReplyEventSubscription<ChatGenerationEvent>
  /** Events received before voice answered, in order. */
  readonly #pending: ChatGenerationEvent[] = []
  /** The speech at voice, once voice answered. */
  #voice: VoiceSpeech | undefined
  /** Whether events are applied at once rather than kept pending. */
  #isLive = false
  /** Whether the reply's end was seen, so the following is expected to end. */
  #hasReplyEnded = false
  /**
   * Whether the following ended before voice answered; `start` decides what
   * that means once the events received meanwhile are applied.
   */
  #hasFollowingEndedEarly = false

  /**
   * Creates a session that has not followed anything or connected yet.
   *
   * @param options - The socket, the stored reply, its generation, the
   * request, the voice connection opener, and the logger.
   */
  public constructor(options: SpeechSessionOptions) {
    const { socket, stored, generation, request, openVoiceSpeech, log } =
      options
    this.#socket = socket
    this.#stored = stored
    this.#generation = generation
    this.#request = request
    this.#openVoiceSpeech = openVoiceSpeech
    this.#log = log
    this.#buffer = new SpeechSentenceBuffer(
      request.kind === "reply" ? request.from : "start"
    )
    this.#textPartIds = new Set(stored.textPartIds)
    this.#subscription = new ReplyEventSubscription<ChatGenerationEvent>(
      this.#handleDeliveredEvent
    )
  }

  /**
   * Follows the reply, connects to voice, and speaks.
   *
   * @returns Settlement once everything known was handed to voice, or the
   * socket was closed; it never rejects.
   * @remarks Must be called in the same synchronous step that read the
   * stored reply, so that the following misses no event.
   */
  public async start(): Promise<void> {
    this.#socket.on("close", this.#handleSocketClose)
    void this.#subscription.closed.then(this.#handleFollowingClosed)
    if (this.#request.kind === "reply")
      this.#generation?.openSubscription(this.#subscription)

    const voice = await this.#openVoice()
    if (voice === undefined) return
    if (!isOpen(this.#socket)) {
      voice.cancel()
      return
    }
    this.#voice = voice
    voice.start()
    if (this.#request.kind === "notification") {
      voice.sendText(this.#request.line)
      voice.sendFinish()
      return
    }
    this.#sendSentences(this.#buffer.loadSnapshot(this.#stored.snapshot))
    if (this.#generation === undefined) {
      this.#sendSentences(this.#buffer.closeRoundText())
      voice.sendFinish()
      return
    }
    this.#isLive = true
    for (const event of this.#pending.splice(0)) this.#handleEvent(event)
    if (this.#hasFollowingEndedEarly) this.#handleFollowingClosed()
  }

  /**
   * Queues an event until voice answered, then applies it.
   *
   * @param event - Event of the followed reply.
   * @returns Settlement for the delivery chain; it never rejects.
   */
  readonly #handleDeliveredEvent = (
    event: ChatGenerationEvent
  ): Promise<void> => {
    if (this.#isLive) this.#handleEvent(event)
    else this.#pending.push(event)
    return Promise.resolve()
  }

  /** Cancels the speech at voice and ends the following once the socket closed. */
  readonly #handleSocketClose = (): void => {
    this.#voice?.cancel()
    this.#subscription.close()
  }

  /**
   * Cuts the speech when the following ends before the reply's end was
   * seen; before voice answered, only records that it ended, because the
   * end event may still wait among the pending ones.
   */
  readonly #handleFollowingClosed = (): void => {
    if (!this.#isLive) {
      this.#hasFollowingEndedEarly = true
      return
    }
    if (this.#hasReplyEnded || !isOpen(this.#socket)) return
    this.#hasReplyEnded = true
    this.#voice?.cancel()
    this.#socket.close(SPEECH_CLOSE_REPLY_ENDED)
  }

  /**
   * Relays voice's close of the speech to the UI's socket.
   *
   * @param code - Voice's close code; `1000` once everything was spoken.
   */
  readonly #handleVoiceClose = (code: number): void => {
    if (!isOpen(this.#socket)) return
    if (code === VOICE_CLOSE_COMPLETE) {
      this.#socket.close(SPEECH_CLOSE_COMPLETE)
      return
    }
    this.#log.warn({ voiceCloseCode: code }, "Voice ended a speech that failed")
    this.#socket.close(SPEECH_CLOSE_FAILED)
  }

  /**
   * Opens the speech at voice, closing the socket when voice refuses.
   *
   * @returns The speech, or undefined once the socket was closed with
   * `4503` for a refused handshake or `1011` for any other failure.
   */
  async #openVoice(): Promise<VoiceSpeech | undefined> {
    try {
      return await this.#openVoiceSpeech({
        onAudio: (pcm) => this.#sendAudioFrame(pcm),
        onClose: this.#handleVoiceClose
      })
    } catch (error) {
      const isRefused = error instanceof VoiceUnavailableError
      if (isRefused) this.#log.warn({ err: error }, "Voice refused a speech")
      else this.#log.error({ err: error }, "Speech could not reach voice")
      if (isOpen(this.#socket))
        this.#socket.close(
          isRefused ? SPEECH_CLOSE_VOICE_UNAVAILABLE : SPEECH_CLOSE_FAILED
        )
      return undefined
    }
  }

  /**
   * Hands sentences to voice, once connected, splitting any sentence too
   * long for one voice message.
   *
   * @param sentences - Sentences to speak, in order.
   */
  #sendSentences(sentences: readonly string[]): void {
    for (const piece of sentences.flatMap((sentence) =>
      buildVoiceTextPieces(sentence)
    )) {
      this.#voice?.sendText(piece)
    }
  }

  /**
   * Forwards one audio frame to the UI, cutting the speech once the UI falls
   * too far behind.
   *
   * @param pcm - Raw PCM bytes of the frame.
   */
  #sendAudioFrame(pcm: Buffer): void {
    if (!isOpen(this.#socket)) return
    const bufferedBytes = this.#socket.bufferedAmount
    if (bufferedBytes > MAX_BUFFERED_BYTES) {
      this.#log.warn({ bufferedBytes }, "Speech socket fell behind its audio")
      this.#voice?.cancel()
      this.#socket.close(SPEECH_CLOSE_TOO_SLOW)
      return
    }
    this.#socket.send(pcm)
  }

  /**
   * Applies one event of the followed reply.
   *
   * @param event - Event of the followed reply, in order.
   */
  #handleEvent(event: ChatGenerationEvent): void {
    switch (event.type) {
      case "reply-part": {
        const part = event.part
        if (part.kind === "tool-call")
          this.#sendSentences(this.#buffer.closeRoundText())
        if (part.kind !== "text") return
        this.#textPartIds.add(part.id)
        this.#sendSentences(this.#buffer.addTextPart(part))
        return
      }
      case "reply-part-delta": {
        if (!this.#textPartIds.has(event.partId)) return
        this.#sendSentences(this.#buffer.addFragment(event.content))
        return
      }
      case "done": {
        this.#hasReplyEnded = true
        this.#sendSentences(this.#buffer.closeRoundText())
        this.#voice?.sendFinish()
        this.#subscription.close()
        return
      }
      case "interrupted":
      case "error": {
        this.#hasReplyEnded = true
        this.#voice?.cancel()
        this.#socket.close(SPEECH_CLOSE_REPLY_ENDED)
        this.#subscription.close()
        return
      }
      case "title":
      case "sources":
      case "tool-call":
      case "tool-approval":
        return
      default: {
        const unhandledEvent: never = event
        throw new TypeError(
          `Unhandled generation event: ${JSON.stringify(unhandledEvent)}`
        )
      }
    }
  }
}
