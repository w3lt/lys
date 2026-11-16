/**
 * Decides when Lys reads Lys's replies aloud, and drives the two WebSockets
 * involved: the reply's speech socket, which carries the reply's audio, and
 * the notification socket, which carries one line for a reply that finished
 * unheard in the background.
 *
 * @remarks The rules, one per situation the chat view can be in:
 *
 * | Situation | What happens |
 * |---|---|
 * | A reply starts streaming | If the window is focused and voice is ready, the speech socket opens with `from=start` for a reply the person asked for, or `from=current` for a running reply the view joined. Otherwise the controller waits. |
 * | The window loses focus before anything was said | Waits silently; the reply is not read. |
 * | The window loses focus while reading | Reads on to the end. |
 * | The window regains focus, voice becomes ready, or the conversation is opened while a reply is streaming | Joins at the sentence being written (`from=current`). |
 * | The reply ends with `done` before anything was said | One notification line is spoken, if the window is not focused; nothing otherwise. |
 * | The reply stops or fails, a new message is sent, or the conversation is switched or closed | Speech stops at once and unplayed audio is dropped. |
 *
 * A socket that closes with `1000` drained; any other close stops playback.
 * At most one reply is spoken at a time; a newly streaming reply replaces
 * whatever was playing.
 */

/** A reply the controller can speak for. */
export type SpeechReply = Readonly<{
  /** Conversation holding the reply. */
  conversationId: string
  /** Backend-owned identifier of the reply message. */
  replyId: string
}>

/** What the chat view shows, as the controller needs it. */
export type SpeechObservation =
  | {
      /** No reply is streaming or awaiting settlement for anything shown. */
      readonly kind: "none"
    }
  | {
      /** A reply is streaming in the shown conversation. */
      readonly kind: "streaming"
      readonly reply: SpeechReply
      /**
       * True when the reply began as a turn the person asked for, so it
       * should be read from its first word; false when the view joined a
       * reply that was already running, which it joins at the sentence
       * being written.
       */
      readonly beganAsNewTurn: boolean
    }
  | {
      /** A reply reached a final state in the shown conversation. */
      readonly kind: "settled"
      readonly reply: SpeechReply
      readonly status: "completed" | "interrupted" | "failed"
    }

/** Player of decoded PCM frames, as `PcmPlayer` implements it. */
export type SpeechPlayer = {
  enqueue: (frame: Uint8Array) => void
  stop: () => void
  /** Asks the audio context to resume, such as after a user gesture. */
  resume: () => void
}

/** One speech or notification socket, as the controller drives it. */
export type SpeechSocket = {
  /** Closes the socket; the backend then cancels the speech. */
  close: () => void
}

/** Handlers a speech or notification socket reports to. */
export type SpeechSocketHandlers = Readonly<{
  /** Called for each binary audio frame. */
  onAudio: (frame: Uint8Array) => void
  /** Called once with the close code when the socket closes. */
  onClose: (code: number) => void
}>

/** Dependencies the controller borrows. */
export type SpeechControllerDeps = Readonly<{
  /** Whether the window has input focus. */
  isFocused: () => boolean
  /** Whether voice answers its health route. */
  isVoiceReady: () => boolean
  /** Builds the path of the speech socket for a reply. */
  speechPath: (reply: SpeechReply, from: "start" | "current") => string
  /** Builds the path of the notification socket for a reply. */
  notificationPath: (reply: SpeechReply) => string
  /** Opens one speech or notification socket. */
  openSocket: (path: string, handlers: SpeechSocketHandlers) => SpeechSocket
  /** Creates the PCM player. */
  createPlayer: () => SpeechPlayer
}>

/** Close code the backend uses when everything was sent. */
const SPEECH_CLOSE_COMPLETE = 1000

/** Most settled replies to remember, so the settle logic runs once each. */
const SETTLED_MEMORY = 128

/** What is open right now. */
type OpenSpeech = {
  /** The reply being spoken. */
  readonly reply: SpeechReply
  /** The open speech socket. */
  readonly socket: SpeechSocket
  /** Frames received so far; zero means nothing was said yet. */
  frames: number
}

/** What is waited for: a streaming reply nothing speaks yet. */
type WaitingSpeech = {
  /** The reply to join once focus or voice allows. */
  readonly reply: SpeechReply
  /** Where to join from. */
  readonly from: "start" | "current"
}

/**
 * The speech controller: one instance per application.
 *
 * @remarks Not thread-safe; the desktop drives it from the main thread only.
 */
export class SpeechController {
  readonly #deps: SpeechControllerDeps
  readonly #player: SpeechPlayer
  /** The reply whose socket is open, if any. */
  #open: OpenSpeech | null = null
  /** The reply being waited on, if any. */
  #waiting: WaitingSpeech | null = null
  /** Replies already handled as settled, oldest first. */
  readonly #settledReplies: string[] = []
  /** Replies already notified, so no reply notifies twice. */
  readonly #notifiedReplies = new Set<string>()
  /** Whether a notification socket is open. */
  #notificationOpen = false

  /**
   * Creates a controller over its dependencies.
   *
   * @param deps - The ports the controller works through.
   */
  public constructor(deps: SpeechControllerDeps) {
    this.#deps = deps
    this.#player = deps.createPlayer()
  }

  /**
   * Re-evaluates what should be audible now.
   *
   * @param observation - What the chat view shows now.
   * @remarks Called on every chat, focus, and voice change; safe to call at
   * any time and idempotent within one state of the world.
   */
  public update(observation: SpeechObservation): void {
    const focused = this.#deps.isFocused()
    const voiceReady = this.#deps.isVoiceReady()
    switch (observation.kind) {
      case "streaming":
        this.#onStreaming(observation, focused, voiceReady)
        break
      case "settled":
        this.#onSettled(observation, focused)
        break
      case "none":
        this.#onQuiet()
        break
    }
    if (!voiceReady && this.#open !== null) {
      // voice died mid-reply; the reply's text keeps streaming either way.
      this.#closeOpen()
      this.#player.stop()
    }
    // A person may send a message from an unfocused window; resuming the
    // audio context here covers any gesture that got this far.
    this.#player.resume()
  }

  /** Stops any speech and notification, and drops queued audio. */
  public stop(): void {
    this.#closeOpen()
    this.#waiting = null
    this.#player.stop()
  }

  /**
   * Handles a reply that is streaming now.
   *
   * @param observation - The streaming reply and how it began.
   * @param focused - Whether the window has focus.
   * @param voiceReady - Whether voice answers its health route.
   */
  #onStreaming(
    observation: Extract<SpeechObservation, { kind: "streaming" }>,
    focused: boolean,
    voiceReady: boolean
  ): void {
    const { reply } = observation
    this.#dropForeign(reply)

    if (this.#open?.reply.replyId === reply.replyId) return

    if (this.#waiting?.reply.replyId === reply.replyId) {
      this.#upgradeWaiting(reply, focused, voiceReady)
      return
    }

    // A reply this controller has not seen stream yet: speak at once, or
    // wait for focus or voice.
    const from = observation.beganAsNewTurn ? "start" : "current"
    if (focused && voiceReady) {
      this.#startSpeech(reply, from)
      return
    }
    this.#waiting = { reply, from }
  }

  /**
   * Drops anything open or waited for that belongs to another reply.
   *
   * @param reply - The reply that is streaming now.
   */
  #dropForeign(reply: SpeechReply): void {
    if (this.#open !== null && this.#open.reply.replyId !== reply.replyId) {
      this.#closeOpen()
      this.#player.stop()
    }
    if (
      this.#waiting !== null &&
      this.#waiting.reply.replyId !== reply.replyId
    ) {
      this.#waiting = null
    }
  }

  /**
   * Opens the speech socket for a reply the controller is waiting on, once
   * focus and voice allow it.
   *
   * @param reply - The waited-for reply.
   * @param focused - Whether the window has focus.
   * @param voiceReady - Whether voice answers its health route.
   */
  #upgradeWaiting(
    reply: SpeechReply,
    focused: boolean,
    voiceReady: boolean
  ): void {
    if (!focused || !voiceReady) return
    this.#waiting = null
    // The reply moved on while we waited; joining at the sentence being
    // written is the only honest place left.
    this.#startSpeech(reply, "current")
  }

  /**
   * Handles a reply that reached its final state.
   *
   * @param observation - The settled reply and its status.
   * @param focused - Whether the window has focus.
   */
  #onSettled(
    observation: Extract<SpeechObservation, { kind: "settled" }>,
    focused: boolean
  ): void {
    const { reply, status } = observation
    if (!this.#rememberSettled(reply, status)) return

    const wasOpen = this.#open?.reply.replyId === reply.replyId
    const wasWaiting = this.#waiting?.reply.replyId === reply.replyId
    if (!wasOpen && !wasWaiting) return

    if (status !== "completed") {
      // The reply stopped or failed: stop at once, dropping unplayed audio.
      this.#closeOpen()
      this.#waiting = null
      this.#player.stop()
      return
    }

    if (wasOpen && this.#open !== null && this.#open.frames > 0) {
      // Part of it was said; let the rest play out. The backend closes the
      // socket with 1000 once its final frame is sent.
      return
    }
    this.#closeOpen()
    this.#waiting = null
    this.#player.stop()
    if (!focused) this.#notify(reply)
  }

  /**
   * Whether this settlement was seen before; remembers the reply when it
   * was not.
   *
   * @param reply - The settled reply.
   * @param status - How it settled.
   * @returns Whether the settlement is new.
   */
  #rememberSettled(reply: SpeechReply, status: string): boolean {
    const key = `${reply.conversationId}:${reply.replyId}:${status}`
    if (this.#settledReplies.includes(key)) return false
    this.#settledReplies.push(key)
    if (this.#settledReplies.length > SETTLED_MEMORY) {
      this.#settledReplies.splice(
        0,
        this.#settledReplies.length - SETTLED_MEMORY
      )
    }
    return true
  }

  /**
   * Handles the absence of a streaming or settled reply being shown: a new
   * message was sent, the conversation was switched or reset, or nothing is
   * happening at all. Speech does not survive any of those.
   */
  #onQuiet(): void {
    this.#waiting = null
    this.#closeOpen()
    this.#player.stop()
  }

  /**
   * Opens the speech socket for a reply.
   *
   * @param reply - The reply to speak.
   * @param from - Where to start; `start` reads from the first word.
   */
  #startSpeech(reply: SpeechReply, from: "start" | "current"): void {
    const socket = this.#deps.openSocket(this.#deps.speechPath(reply, from), {
      onAudio: (frame) => {
        if (this.#open?.socket !== socket) return
        this.#open.frames += 1
        this.#player.enqueue(frame)
      },
      onClose: (code) => {
        if (this.#open?.socket !== socket) return
        this.#open = null
        if (code !== SPEECH_CLOSE_COMPLETE) this.#player.stop()
      }
    })
    this.#open = { reply, socket, frames: 0 }
  }

  /** Closes the speech socket, if any, without touching queued audio. */
  #closeOpen(): void {
    const open = this.#open
    this.#open = null
    open?.socket.close()
  }

  /**
   * Opens the notification socket for a reply that finished unheard.
   *
   * @param reply - The reply to announce.
   */
  #notify(reply: SpeechReply): void {
    if (this.#notificationOpen) return
    if (this.#notifiedReplies.has(reply.replyId)) return
    this.#notifiedReplies.add(reply.replyId)
    this.#notificationOpen = true
    try {
      this.#deps.openSocket(this.#deps.notificationPath(reply), {
        onAudio: (frame) => {
          this.#player.enqueue(frame)
        },
        onClose: () => {
          this.#notificationOpen = false
        }
      })
    } catch {
      this.#notificationOpen = false
    }
  }
}
