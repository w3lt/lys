import {
  SPEECH_CLOSE_COMPLETE,
  SPEECH_CLOSE_FAILED,
  SPEECH_CLOSE_NO_SUCH_REPLY,
  SPEECH_CLOSE_REPLY_ENDED,
  SPEECH_CLOSE_VOICE_UNAVAILABLE
} from "@lys/protocol"
import type { ChatReplyEvent } from "@lys/protocol"
import type { ConversationAssistantMessage } from "@lys/share"
import type { WebSocket } from "ws"
import type ReplyGenerationRegistry from "../chat/replyGenerationRegistry"
import ReplyEventSubscription from "../chat/replyEventSubscription"
import type { ConversationReader } from "../conversation/capabilities"
import type { SpeechSocketRegistry } from "./speechSocketRegistry"
import {
  type connectVoiceSpeech,
  type isVoiceReady,
  type VoiceSpeech
} from "./voiceClient"
import { SpeechSentenceBuffer } from "./speechText"

/**
 * How many unsent bytes may wait for a slow UI socket before the speech is
 * cut off. At 48 KB/s of audio this is about twenty seconds of speech.
 */
const MAX_BUFFERED_BYTES = 1_000_000

/** Close code sent when the UI falls too far behind to keep up with audio. */
const WS_BUFFERED_TOO_LONG = 1008

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
      from: "start" | "current"
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
  /** Registry that supersedes older sockets for the same reply. */
  registry: SpeechSocketRegistry
  /** Voice readiness probe; injected in tests. */
  isReady: typeof isVoiceReady
  /** Voice connection opener; injected in tests. */
  connect: typeof connectVoiceSpeech
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
}>

/**
 * Speaks one reply or one notification line onto a socket the UI opened.
 *
 * @param options - The socket, its target, what to speak, and the deps.
 * @returns Settlement once the socket has been closed. Never throws.
 * @remarks Closes the socket with the code the UI understands: the reply is
 * missing (`4404`), voice is not ready (`4503`), the reply stopped or is not
 * being written when `from` is `current` (`4410`), the UI did not keep up
 * (`1008`), or voice's own outcome mapped to `1000` or `1011`. A newer socket
 * for the same reply closes this one with `4409` first.
 */
export async function handleSpeechConnection(
  options: SpeechConnectionOptions
): Promise<void> {
  const { socket, target, request, deps } = options
  const key = `${target.conversationId}/${target.assistantMessageId}`
  deps.registry.register(key, socket)
  socket.on("close", () => deps.registry.unregister(key, socket))
  // A socket error must not become an unhandled error; its close follows.
  socket.on("error", () => {})

  const storedReply = readStoredReply(deps.history, target)
  if (storedReply.kind === "missing") {
    socket.close(SPEECH_CLOSE_NO_SUCH_REPLY)
    return
  }
  if (storedReply.kind === "unreadable") {
    socket.close(SPEECH_CLOSE_FAILED)
    return
  }
  const stored = storedReply.reply
  if (!(await deps.isReady())) {
    socket.close(SPEECH_CLOSE_VOICE_UNAVAILABLE)
    return
  }
  // The generation is looked up before anything is sent, so that a
  // `current` speech for a finished reply is refused up front. A settled
  // generation may still be registered for an instant; the stored reply
  // already says the reply is over, so speak it instead of waiting for
  // events that will never arrive.
  let generation = deps.generations.findReplyGeneration(target)
  if (generation !== undefined && !stored.isStreaming) generation = undefined
  if (
    request.kind === "reply" &&
    request.from === "current" &&
    generation === undefined
  ) {
    socket.close(SPEECH_CLOSE_REPLY_ENDED)
    return
  }

  const session = new SpeechSession({
    socket,
    stored,
    generation,
    request,
    deps
  })
  await session.start()
}

/** The stored reply a socket speaks, with its text parts split out. */
type StoredReply = Readonly<{
  /** Markdown text of the reply's text parts, in order, joined by blank lines. */
  text: string
  /** Identifiers of the text parts, so streamed deltas can be matched. */
  textPartIds: ReadonlySet<string>
  /** Whether the stored reply is still streaming. */
  isStreaming: boolean
}>

/** Read outcome of the stored reply a socket speaks. */
type StoredReplyResult =
  | Readonly<{ kind: "found"; reply: StoredReply }>
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "unreadable" }>

/** Reads the stored reply. */
function readStoredReply(
  history: ConversationReader,
  target: SpeechTarget
): StoredReplyResult {
  let conversation
  try {
    conversation = history.getConversation(target.conversationId)
  } catch {
    return { kind: "unreadable" }
  }
  const message = conversation?.messages.find(
    (candidate): candidate is ConversationAssistantMessage =>
      candidate.role === "assistant" &&
      candidate.id === target.assistantMessageId
  )
  if (message === undefined) return { kind: "missing" }
  const textParts = message.parts.filter((part) => part.kind === "text")
  return {
    kind: "found",
    reply: Object.freeze({
      text: textParts.map((part) => part.content).join("\n\n"),
      textPartIds: new Set(textParts.map((part) => part.id)),
      isStreaming: message.status === "streaming"
    })
  }
}

/** Closes the socket with the code voice's close maps to. */
function closeWithVoiceCode(socket: WebSocket, code: number): void {
  socket.close(code === 1000 ? SPEECH_CLOSE_COMPLETE : SPEECH_CLOSE_FAILED)
}

/**
 * Owns one speech from voice connection to close: what to speak, the frames
 * flowing voice to socket, and the end of the speech.
 */
/** What one speech session needs. */
type SpeechSessionOptions = Readonly<{
  /** The UI's socket. */
  socket: WebSocket
  /** The reply stored when the socket opened. */
  stored: StoredReply
  /** The generation being followed, if any. */
  generation: ReturnType<ReplyGenerationRegistry["findReplyGeneration"]>
  /** What to speak and from where. */
  request: SpeechRequest
  /** Borrowed dependencies. */
  deps: SpeechConnectionDependencies
}>

class SpeechSession {
  readonly #socket: WebSocket
  readonly #stored: StoredReply
  readonly #generation: ReturnType<
    ReplyGenerationRegistry["findReplyGeneration"]
  >
  readonly #request: SpeechRequest
  readonly #deps: SpeechConnectionDependencies
  /** Sentences flow here; the snapshot seeds it and deltas extend it. */
  readonly #buffer: SpeechSentenceBuffer
  /** Ids of the text parts seen so far; deltas of other parts are dropped. */
  readonly #textPartIds: Set<string>
  readonly #subscription: ReplyEventSubscription<ChatReplyEvent>
  readonly #pending: ChatReplyEvent[] = []
  #voice: VoiceSpeech | undefined
  #live = false
  #hasText: boolean
  /** Whether a terminal reply event was seen; guards the fallback when the subscription ends on its own. */
  #terminalSeen = false

  public constructor(options: SpeechSessionOptions) {
    const { socket, stored, generation, request, deps } = options
    this.#socket = socket
    this.#stored = stored
    this.#generation = generation
    this.#request = request
    this.#deps = deps
    const from = request.kind === "reply" ? request.from : "start"
    this.#buffer = new SpeechSentenceBuffer(from)
    this.#textPartIds = new Set(stored.textPartIds)
    this.#hasText = stored.text.length > 0
    this.#subscription = new ReplyEventSubscription<ChatReplyEvent>(
      this.#receiveEvent
    )
    // A subscription that ends without a terminal event means the reply
    // ended between the snapshot and the follow, or a write failed; the
    // reply will say nothing more, so stop the speech.
    void this.#subscription.closed.then(this.#subscriptionClosed)
  }

  /**
   * Queues an event until the session is live, then applies it.
   *
   * @param event - Event of the followed reply.
   * @returns Settlement for the delivery chain.
   */
  readonly #receiveEvent = (event: ChatReplyEvent): Promise<void> => {
    if (!this.#live) this.#pending.push(event)
    else this.#handleEvent(event)
    return Promise.resolve()
  }

  /** Cuts the speech when the followed reply ends without a terminal event. */
  readonly #subscriptionClosed = (): void => {
    if (this.#terminalSeen) return
    this.#terminalSeen = true
    this.#voice?.cancel()
    this.#socket.close(SPEECH_CLOSE_REPLY_ENDED)
  }

  /**
   * Connects to voice, registers with the generation when the reply is being
   * written, and speaks.
   *
   * @returns Settlement once the socket has been closed.
   */
  public async start(): Promise<void> {
    if (this.#request.kind === "notification") {
      await this.#startNotification()
      return
    }

    // Opening the subscription before connecting to voice closes the gap in
    // which fragments would otherwise be missed: they queue in `#pending`
    // and are replayed once the pipeline is live.
    if (this.#generation !== undefined) {
      this.#generation.openSubscription(this.#subscription)
    }

    let voice: VoiceSpeech
    try {
      voice = await this.#deps.connect({
        onAudio: (pcm) => this.#forwardAudio(pcm),
        onClose: (code) => closeWithVoiceCode(this.#socket, code)
      })
    } catch {
      this.#subscription.close()
      this.#socket.close(SPEECH_CLOSE_VOICE_UNAVAILABLE)
      return
    }
    this.#voice = voice
    this.#socket.on("close", () => {
      voice.cancel()
      this.#subscription.close()
    })

    voice.speak()
    this.#speak(this.#buffer.loadSnapshot(this.#stored.text))

    if (this.#generation === undefined) {
      this.#speak(this.#buffer.finish())
      voice.finish()
      return
    }
    this.#live = true
    for (const event of this.#pending.splice(0)) this.#handleEvent(event)
  }

  /** Speaks one notification line on its own, without following a reply. */
  async #startNotification(): Promise<void> {
    const request = this.#request
    if (request.kind !== "notification") return
    let voice: VoiceSpeech
    try {
      voice = await this.#deps.connect({
        onAudio: (pcm) => this.#forwardAudio(pcm),
        onClose: (code) => closeWithVoiceCode(this.#socket, code)
      })
    } catch {
      this.#socket.close(SPEECH_CLOSE_VOICE_UNAVAILABLE)
      return
    }
    this.#voice = voice
    this.#socket.on("close", () => voice.cancel())
    voice.speak()
    voice.speakText(request.line)
    voice.finish()
  }

  /** Sends sentences to voice, if connected. */
  #speak(sentences: string[]): void {
    for (const sentence of sentences) this.#voice?.speakText(sentence)
  }

  /** Forwards one audio frame to the UI, closing on overflow. */
  #forwardAudio(pcm: Buffer): void {
    if (this.#socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.#voice?.cancel()
      this.#socket.close(WS_BUFFERED_TOO_LONG)
      return
    }
    this.#socket.send(pcm)
  }

  /** Applies one event of the followed reply. */
  #handleEvent(event: ChatReplyEvent): void {
    switch (event.type) {
      case "reply-part": {
        const part = event.part
        if (part.kind !== "text") return
        this.#textPartIds.add(part.id)
        const prefix = this.#hasText ? "\n\n" : ""
        this.#hasText = true
        this.#speak(this.#buffer.push(prefix + part.content))
        return
      }
      case "reply-part-delta": {
        if (!this.#textPartIds.has(event.partId)) return
        this.#hasText = true
        this.#speak(this.#buffer.push(event.content))
        return
      }
      case "done": {
        this.#terminalSeen = true
        this.#speak(this.#buffer.finish())
        this.#voice?.finish()
        this.#subscription.close()
        return
      }
      case "interrupted":
      case "error": {
        this.#terminalSeen = true
        this.#voice?.cancel()
        this.#socket.close(SPEECH_CLOSE_REPLY_ENDED)
        this.#subscription.close()
        return
      }
      default:
        return
    }
  }
}
