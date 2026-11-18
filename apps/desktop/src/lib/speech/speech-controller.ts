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
 * | The window loses focus before anything was said | The socket closes and the controller waits silently. |
 * | The window loses focus while reading | Reads on to the end. |
 * | Silent mid-reply, and the window regains focus, voice becomes ready, or the conversation is opened | Joins at the sentence being written (`from=current`). |
 * | The reply ends with `done` in the background before anything was said | One notification line is spoken. |
 * | The reply ends with `done` while the window is focused | The speech socket stays open until the backend's `1000`. |
 * | The reply stops or fails, a new message is sent, the conversation is switched or closed, or voice stops | Speech and any notification stop at once and unplayed audio is dropped. |
 *
 * A socket that closes with `1000` drained; any other close stops playback,
 * and the reply is joined again only on one of the triggers above, never on
 * an ordinary chat update. At most one socket is open at a time, so Lys never
 * talks over herself.
 */
import {
  SPEECH_CLOSE_COMPLETE,
  SPEECH_CLOSE_FAILED,
  SPEECH_CLOSE_VOICE_UNAVAILABLE
} from "@lys/protocol"

/** A reply the controller can speak for. */
export type SpeechReply = Readonly<{
  /** Conversation holding the reply. */
  conversationId: string
  /** Backend-owned identifier of the reply message. */
  replyId: string
}>

/** What the chat view shows, as the controller needs it. */
export type SpeechObservation =
  | Readonly<{
      /** No reply is streaming or settled in the shown conversation. */
      kind: "none"
    }>
  | Readonly<{
      /** A reply is streaming in the shown conversation. */
      kind: "streaming"
      /** The streaming reply. */
      reply: SpeechReply
      /**
       * True when the reply began as a turn the person asked for, so it
       * should be read from its first word; false when the view joined a
       * reply that was already running, which it joins at the sentence
       * being written.
       */
      beganAsNewTurn: boolean
    }>
  | Readonly<{
      /** A reply reached a final state in the shown conversation. */
      kind: "settled"
      /** The settled reply. */
      reply: SpeechReply
      /** How the reply ended. */
      status: "completed" | "interrupted" | "failed"
    }>

/** Player of decoded PCM frames, as `PcmPlayer` implements it. */
export type SpeechPlayer = Readonly<{
  /** Queues one frame of raw PCM for playback. */
  enqueue: (frame: Uint8Array) => void
  /** Stops every queued frame at once. */
  stop: () => void
  /** Asks the audio context to resume, such as after a user gesture. */
  resume: () => void
  /** Stops every queued frame and releases the audio context. */
  close: () => void
}>

/** One speech or notification socket, as the controller drives it. */
export type SpeechSocket = Readonly<{
  /** Closes the socket; the backend then cancels the speech. */
  close: () => void
}>

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
  /** Creates the PCM player, which the controller then owns. */
  createPlayer: () => SpeechPlayer
  /**
   * Asks the application to read voice's status again, after a socket closed
   * because voice was unavailable or failed.
   */
  recheckVoice: () => void
}>

/** Most settled replies to remember, so the settle logic runs once each. */
const SETTLED_MEMORY = 128

/** The open speech socket. */
type OpenSpeech = {
  /** The reply being spoken. */
  readonly reply: SpeechReply
  /** The open speech socket. */
  readonly socket: SpeechSocket
  /** Frames received so far; zero means nothing was said yet. */
  frames: number
}

/** The open notification socket. */
type OpenNotification = Readonly<{
  /** The reply the notification is for. */
  reply: SpeechReply
  /** The open notification socket. */
  socket: SpeechSocket
}>

/** A streaming reply nothing speaks yet. */
type WaitingSpeech = Readonly<{
  /** The reply to join once focus or voice allows. */
  reply: SpeechReply
  /**
   * True after its socket closed on its own: the reply is joined again only
   * when the window regains focus or voice becomes ready, never on an
   * ordinary chat update, so a failing socket is not reopened in a loop.
   */
  needsTrigger: boolean
}>

/** What one update sees of the world. */
type UpdateContext = Readonly<{
  /** Whether the window has focus. */
  focused: boolean
  /** Whether voice answers its health route. */
  voiceReady: boolean
  /** Whether the window just regained focus or voice just became ready. */
  isJoinTrigger: boolean
}>

/**
 * The speech controller: one instance per application.
 *
 * @remarks Owns the player it creates and the sockets it opens: one speech
 * socket and one notification socket at most, never both. `close()` releases
 * all of them and is terminal: later calls do nothing. Not thread-safe; the
 * desktop drives it from the main thread only.
 */
export class SpeechController {
  /** The ports the controller works through. */
  readonly #deps: SpeechControllerDeps
  /** The player of every frame either socket receives. */
  readonly #player: SpeechPlayer
  /** The reply whose speech socket is open, if any. */
  #open: OpenSpeech | null = null
  /** The reply being waited on, if any. */
  #waiting: WaitingSpeech | null = null
  /** The open notification socket and the reply it is for, if any. */
  #notification: OpenNotification | null = null
  /** Replies already handled as settled, oldest first. */
  readonly #settledReplies: string[] = []
  /** Focus at the previous update; undefined before the first. */
  #wasFocused: boolean | undefined
  /** Voice readiness at the previous update; undefined before the first. */
  #wasVoiceReady: boolean | undefined
  /** Whether `close()` ran. */
  #isClosed = false

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
   * any time and idempotent within one state of the world. Does nothing once
   * the controller is closed.
   */
  public update(observation: SpeechObservation): void {
    if (this.#isClosed) return
    const focused = this.#deps.isFocused()
    const voiceReady = this.#deps.isVoiceReady()
    const context: UpdateContext = {
      focused,
      voiceReady,
      isJoinTrigger:
        (focused && this.#wasFocused === false) ||
        (voiceReady && this.#wasVoiceReady === false)
    }
    this.#wasFocused = focused
    this.#wasVoiceReady = voiceReady
    if (!voiceReady) this.#silenceForVoice()
    switch (observation.kind) {
      case "streaming":
        this.#onStreaming(observation, context)
        break
      case "settled":
        this.#onSettled(observation, focused)
        break
      case "none":
        this.#silence()
        this.#waiting = null
        break
    }
    // A person may send a message from an unfocused window; resuming the
    // audio context here covers any gesture that got this far.
    if (voiceReady) this.#player.resume()
  }

  /** Stops any speech and notification, releases the player, and ends. */
  public close(): void {
    if (this.#isClosed) return
    this.#isClosed = true
    this.#waiting = null
    this.#closeOpen()
    this.#closeNotification()
    this.#player.close()
  }

  /**
   * Handles a reply that is streaming now.
   *
   * @param observation - The streaming reply and how it began.
   * @param context - What this update sees of the world.
   */
  #onStreaming(
    observation: Extract<SpeechObservation, { kind: "streaming" }>,
    context: UpdateContext
  ): void {
    const { reply } = observation
    this.#dropForeign(reply)
    if (this.#notification !== null) {
      this.#closeNotification()
      this.#player.stop()
    }

    if (this.#open?.reply.replyId === reply.replyId) {
      if (this.#open.frames > 0 || context.focused) return
      // The window lost focus before anything was said: wait silently.
      this.#closeOpen()
      this.#waiting = { reply, needsTrigger: false }
      return
    }

    if (this.#waiting?.reply.replyId === reply.replyId) {
      this.#joinWaiting(this.#waiting, context)
      return
    }

    // A reply this controller has not seen stream yet: speak at once, or
    // wait for focus or voice.
    if (context.focused && context.voiceReady) {
      this.#startSpeech(reply, observation.beganAsNewTurn ? "start" : "current")
      return
    }
    this.#waiting = { reply, needsTrigger: false }
  }

  /**
   * Drops anything open, notified, or waited for that belongs to another
   * reply, such as once the view shows another conversation.
   *
   * @param reply - The reply the view shows now.
   */
  #dropForeign(reply: SpeechReply): void {
    if (this.#open !== null && this.#open.reply.replyId !== reply.replyId) {
      this.#closeOpen()
      this.#player.stop()
    }
    if (
      this.#notification !== null &&
      this.#notification.reply.replyId !== reply.replyId
    ) {
      this.#closeNotification()
      this.#player.stop()
    }
    if (this.#waiting?.reply.replyId !== reply.replyId) this.#waiting = null
  }

  /**
   * Joins a waited-for reply at the sentence being written, once focus and
   * voice allow it.
   *
   * @param waiting - The waited-for reply.
   * @param context - What this update sees of the world.
   */
  #joinWaiting(waiting: WaitingSpeech, context: UpdateContext): void {
    if (!context.focused || !context.voiceReady) return
    if (waiting.needsTrigger && !context.isJoinTrigger) return
    this.#waiting = null
    // The reply moved on while we waited; joining at the sentence being
    // written is the only honest place left.
    this.#startSpeech(waiting.reply, "current")
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
    this.#dropForeign(reply)
    const isNewSettlement = this.#rememberSettled(reply, status)
    if (status === "completed")
      this.#onCompleted(reply, isNewSettlement, focused)
    else if (isNewSettlement) this.#onStoppedOrFailed(reply)
  }

  /**
   * Stops at once, dropping unplayed audio, for a reply that stopped or
   * failed while it was spoken or waited for.
   *
   * @param reply - The reply that stopped or failed.
   */
  #onStoppedOrFailed(reply: SpeechReply): void {
    const isOpen = this.#open?.reply.replyId === reply.replyId
    if (!isOpen && this.#waiting?.reply.replyId !== reply.replyId) return
    this.#silence()
    this.#waiting = null
  }

  /**
   * Lets a reply that completed play out, or notifies for it when it ended
   * in the background before anything was said.
   *
   * @param reply - The completed reply.
   * @param isNewSettlement - Whether this update is the first to see it
   * completed.
   * @param focused - Whether the window has focus.
   */
  #onCompleted(
    reply: SpeechReply,
    isNewSettlement: boolean,
    focused: boolean
  ): void {
    const open = this.#open
    if (open?.reply.replyId === reply.replyId) {
      // Focused, or part of it was said: the backend speaks the rest and
      // closes the socket with 1000 once its final frame is sent.
      if (open.frames > 0 || focused) return
      // It ended in the background before anything was said.
      this.#silence()
      this.#notify(reply)
      return
    }
    if (!isNewSettlement || this.#waiting?.reply.replyId !== reply.replyId)
      return
    this.#waiting = null
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
   * Stops everything audible once voice is not ready, keeping the reply
   * spoken so far as waited for, to join once voice is ready again.
   */
  #silenceForVoice(): void {
    if (this.#open !== null) {
      this.#waiting = { reply: this.#open.reply, needsTrigger: true }
    }
    this.#silence()
  }

  /** Closes both sockets and drops every queued frame. */
  #silence(): void {
    this.#closeOpen()
    this.#closeNotification()
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
        this.#waiting = { reply, needsTrigger: true }
        this.#handleClose(code)
      }
    })
    this.#open = { reply, socket, frames: 0 }
  }

  /**
   * Opens the notification socket for a reply that finished unheard.
   *
   * @param reply - The reply to announce.
   */
  #notify(reply: SpeechReply): void {
    this.#closeNotification()
    const socket = this.#deps.openSocket(this.#deps.notificationPath(reply), {
      onAudio: (frame) => {
        if (this.#notification?.socket === socket) this.#player.enqueue(frame)
      },
      onClose: (code) => {
        if (this.#notification?.socket !== socket) return
        this.#notification = null
        this.#handleClose(code)
      }
    })
    this.#notification = { reply, socket }
  }

  /**
   * Handles the close of the current speech or notification socket.
   *
   * @param code - The close code the backend sent.
   * @remarks Only `1000` lets the queued audio play out. `4503` and `1011`
   * may mean voice is gone, so the application reads its status again.
   */
  #handleClose(code: number): void {
    if (code === SPEECH_CLOSE_COMPLETE) return
    this.#player.stop()
    if (code === SPEECH_CLOSE_VOICE_UNAVAILABLE || code === SPEECH_CLOSE_FAILED)
      this.#deps.recheckVoice()
  }

  /** Closes the speech socket, if any, without touching queued audio. */
  #closeOpen(): void {
    const open = this.#open
    this.#open = null
    open?.socket.close()
  }

  /** Closes the notification socket, if any, without touching queued audio. */
  #closeNotification(): void {
    const notification = this.#notification
    this.#notification = null
    notification?.socket.close()
  }
}
