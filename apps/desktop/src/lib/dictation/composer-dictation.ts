/**
 * Runs a dictation: it records the microphone, sends the audio to the
 * backend's dictation socket, and writes the text that comes back into the
 * composer's draft, where the cursor was when the dictation started.
 *
 * @remarks The rules, one per thing that can happen:
 *
 * | What happens | Result |
 * |---|---|
 * | The button is pressed while nothing runs | The socket opens and the microphone is asked for; the dictation is `starting`, then `listening` once the microphone is open. |
 * | The button is pressed while starting | The start is cancelled. |
 * | The button is pressed while listening | The microphone is released, `stop` is sent, and the dictation waits up to five seconds for the final text. |
 * | A `partial` arrives | The draft holds the typed text with everything dictated so far. |
 * | A `final` arrives | The draft holds the final text, and the dictation ends; one that arrives while listening, as at the backend's time limit, also releases the microphone. |
 * | No final text arrives in time | The last partial stays, and the dictation ends. |
 * | The microphone cannot be opened | The dictation ends with a notice that says why. |
 * | The socket closes first | The text so far stays, and the dictation ends with a notice. |
 * | The draft is changed by anything else, or the dictation is cancelled | The dictation ends at once and writes nothing more. |
 *
 * The microphone is released on every path out of `listening`, and nothing
 * is sent or written for a dictation once it ended. Whether Lys may listen
 * when the button is pressed is the caller's rule, not this module's.
 */
import {
  DICTATION_CLOSE_COMPLETE,
  DICTATION_CLOSE_FAILED,
  DICTATION_CLOSE_VOICE_UNAVAILABLE,
  dictationServerMessageSchema,
  type DictationServerMessage
} from "@lys/protocol"

import {
  buildDictatedDraft,
  buildDictationAnchor,
  type DictationAnchor
} from "./dictated-draft"
import {
  MicrophoneError,
  type MicrophoneFailure,
  type MicrophoneRecorder,
  type MicrophoneRecorderOptions
} from "./microphone-recorder"

/**
 * Where a dictation stands.
 *
 * @remarks `starting`: the microphone is being opened, and may already be
 * open. `listening`: the microphone is open and its audio is sent.
 * `stopping`: the microphone is released and the final text is awaited.
 */
export type DictationStatus = "idle" | "starting" | "listening" | "stopping"

/**
 * Why the last dictation ended on its own.
 *
 * @remarks `voice-not-ready`: voice was not ready to listen.
 * `microphone-denied`, `microphone-missing`, `microphone-failed`: the
 * microphone could not be opened. `voice-stopped`: voice failed while it
 * listened. `stopped`: the dictation ended for any other reason, such as the
 * microphone being unplugged or the backend closing the socket.
 */
export type DictationNotice =
  | "voice-not-ready"
  | "microphone-denied"
  | "microphone-missing"
  | "microphone-failed"
  | "voice-stopped"
  | "stopped"

/** What the composer shows of the dictation. */
export type DictationView = Readonly<{
  /** Where the dictation stands. */
  status: DictationStatus
  /**
   * Why the last dictation ended on its own, until the next one starts or
   * the dictation is cancelled; undefined when it did not.
   */
  notice: DictationNotice | undefined
  /**
   * Whether the running dictation writes at the draft's end, so the field
   * can keep its last line in view; false while none runs.
   */
  isAtDraftEnd: boolean
}>

/** The backend's dictation socket, as the composer's dictation drives it. */
export type DictationSocket = Readonly<{
  /**
   * Sends one frame of dictation audio.
   *
   * @param frame - Signed 16-bit little-endian PCM at the dictation's sample
   * rate, one channel.
   */
  sendAudio: (frame: Uint8Array<ArrayBuffer>) => void
  /** Asks for the final text. */
  sendStop: () => void
  /** Closes the socket; the backend then cancels the dictation. */
  close: () => void
}>

/** Handlers a dictation socket reports to. */
export type DictationSocketHandlers = Readonly<{
  /**
   * Called for each text message.
   *
   * @param text - The message, as the backend sent it.
   */
  onText: (text: string) => void
  /**
   * Called once when the socket closes.
   *
   * @param code - The close code.
   */
  onClose: (code: number) => void
}>

/** What the composer's dictation borrows. */
export type ComposerDictationDeps = Readonly<{
  /** Gets the composer's draft. */
  getDraft: () => string
  /**
   * Replaces the composer's draft.
   *
   * @param draft - The new draft.
   */
  updateDraft: (draft: string) => void
  /**
   * Opens the microphone and starts recording it.
   *
   * @param options - The frames' receiver, the microphone's end, and the
   * signal that cancels the start.
   * @returns The running recording. Rejects with a `MicrophoneError` when
   * the microphone cannot be opened, and with any value once the signal
   * aborted.
   */
  startRecorder: (
    options: MicrophoneRecorderOptions
  ) => Promise<MicrophoneRecorder>
  /**
   * Opens the backend's dictation socket.
   *
   * @param handlers - Receive each text message and the close.
   * @returns The socket, which takes messages at once.
   */
  openSocket: (handlers: DictationSocketHandlers) => DictationSocket
  /**
   * Called with what the composer shows, on every change.
   *
   * @param view - The dictation's status and notice.
   */
  onViewChange: (view: DictationView) => void
}>

/** How long the final text is awaited after a stop, in milliseconds. */
const FINAL_TEXT_WAIT_MS = 5_000

/** The notice for each way the microphone can fail to open. */
const MICROPHONE_NOTICES = Object.freeze({
  denied: "microphone-denied",
  missing: "microphone-missing",
  failed: "microphone-failed"
} satisfies Readonly<Record<MicrophoneFailure, DictationNotice>>)

/** One dictation, from its start to its end. */
type DictationSession = {
  /** Aborted once the dictation ended; nothing of it is handled afterwards. */
  readonly abort: AbortController
  /** The dictation's socket. */
  readonly socket: DictationSocket
  /** The typed text on each side of the cursor. */
  readonly anchor: DictationAnchor
  /** The draft as the dictation last read or wrote it. */
  draft: string
}

/** Where the composer's dictation stands, with what each stage holds. */
type DictationStage =
  | {
      /** No dictation runs. */
      readonly phase: "idle"
    }
  | {
      /** The microphone is being opened. */
      readonly phase: "starting"
      /** The running dictation. */
      readonly session: DictationSession
    }
  | {
      /** The microphone is open and its audio is sent. */
      readonly phase: "listening"
      /** The running dictation. */
      readonly session: DictationSession
      /** The open microphone. */
      readonly recorder: MicrophoneRecorder
    }
  | {
      /** The final text is awaited. */
      readonly phase: "stopping"
      /** The running dictation. */
      readonly session: DictationSession
      /** Ends the wait for the final text. */
      readonly timer: ReturnType<typeof setTimeout>
    }

/**
 * Parses one text message of the dictation socket.
 *
 * @param text - The message, as the backend sent it.
 * @returns The message, or undefined when it is not JSON or not a dictation
 * message.
 */
function parseServerMessage(text: string): DictationServerMessage | undefined {
  try {
    const parsed = dictationServerMessageSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

/**
 * Finds the notice for a socket that closed before the final text.
 *
 * @param code - The socket's close code.
 * @returns Undefined for a complete dictation, the notice for voice not
 * being ready or having failed, and `stopped` for every other code.
 */
function findCloseNotice(code: number): DictationNotice | undefined {
  if (code === DICTATION_CLOSE_COMPLETE) return undefined
  if (code === DICTATION_CLOSE_VOICE_UNAVAILABLE) return "voice-not-ready"
  return code === DICTATION_CLOSE_FAILED ? "voice-stopped" : "stopped"
}

/**
 * Runs one dictation at a time for the composer.
 *
 * @remarks Lifecycle: one instance for the application; the owner calls
 * {@link ComposerDictation.cancel} before it lets the instance go, which
 * releases the microphone, the socket, and the timer.
 * Concurrency model: serialized on the UI thread. A dictation's callbacks
 * carry its abort signal, and a callback whose signal aborted does nothing,
 * so a recording that starts late, a late message, and a late close of an
 * ended dictation change nothing.
 */
export class ComposerDictation {
  /** What the instance borrows. */
  readonly #deps: ComposerDictationDeps
  /** Where the dictation stands. */
  #state: DictationStage = { phase: "idle" }
  /** Why the last dictation ended on its own. */
  #notice: DictationNotice | undefined

  /**
   * Creates the composer's dictation, with none running.
   *
   * @param deps - What the instance borrows.
   */
  public constructor(deps: ComposerDictationDeps) {
    this.#deps = deps
  }

  /**
   * Handles a press of the dictation button: starts a dictation while none
   * runs, and stops the running one otherwise.
   *
   * @param cursor - Offset of the cursor in the draft, where a new dictation
   * writes.
   * @remarks A press while the final text is awaited does nothing. The
   * caller decides whether Lys may listen before it asks for a start.
   */
  public handleButtonPress(cursor: number): void {
    if (this.#state.phase === "idle") this.#start(cursor)
    else this.stop()
  }

  /**
   * Stops the running dictation as a press of the button does: a start is
   * cancelled, and a listening dictation releases the microphone and waits
   * for its final text.
   */
  public stop(): void {
    if (this.#state.phase === "starting") this.#closeDictation(undefined)
    else this.#stopListening(undefined)
  }

  /**
   * Ends the running dictation at once: the microphone and the socket are
   * released, the notice is cleared, and nothing more is written.
   */
  public cancel(): void {
    this.#closeDictation(undefined)
    if (this.#notice === undefined) return
    this.#notice = undefined
    this.#sendView()
  }

  /**
   * Cancels the running dictation when something else changed the draft.
   *
   * @param draft - The composer's draft after a change.
   */
  public handleDraftChange(draft: string): void {
    const state = this.#state
    if (state.phase !== "idle" && state.session.draft !== draft) this.cancel()
  }

  /**
   * Starts a dictation: opens the socket and asks for the microphone.
   *
   * @param cursor - Offset of the cursor in the draft.
   */
  #start(cursor: number): void {
    const abort = new AbortController()
    const draft = this.#deps.getDraft()
    const socket = this.#deps.openSocket({
      onText: (text) => {
        this.#handleText(abort.signal, text)
      },
      onClose: (code) => {
        this.#handleClose(abort.signal, code)
      }
    })
    const anchor = buildDictationAnchor(draft, cursor)
    this.#notice = undefined
    this.#state = {
      phase: "starting",
      session: { abort, socket, anchor, draft }
    }
    this.#sendView()
    void this.#startRecorder(abort.signal)
  }

  /**
   * Opens the microphone for the dictation that is starting.
   *
   * @param signal - The dictation's signal.
   * @returns Settlement once the dictation listens, ended, or failed; never
   * rejects.
   */
  async #startRecorder(signal: AbortSignal): Promise<void> {
    let recorder: MicrophoneRecorder
    try {
      recorder = await this.#deps.startRecorder({
        signal,
        onFrame: (frame) => {
          this.#sendFrame(signal, frame)
        },
        onEnded: () => {
          if (!signal.aborted) this.#stopListening("stopped")
        }
      })
    } catch (error) {
      if (signal.aborted) return
      const kind = error instanceof MicrophoneError ? error.kind : "failed"
      this.#closeDictation(MICROPHONE_NOTICES[kind])
      return
    }
    const state = this.#state
    if (signal.aborted || state.phase !== "starting") {
      recorder.stop()
      return
    }
    this.#state = { phase: "listening", session: state.session, recorder }
    this.#sendView()
  }

  /**
   * Sends one frame of the open microphone to the socket.
   *
   * @param signal - Signal of the dictation the frame belongs to.
   * @param frame - The frame.
   */
  #sendFrame(signal: AbortSignal, frame: Uint8Array<ArrayBuffer>): void {
    const state = this.#state
    if (signal.aborted || state.phase !== "listening") return
    state.session.socket.sendAudio(frame)
  }

  /**
   * Releases the microphone of a listening dictation, asks for its final
   * text, and starts the wait for it.
   *
   * @param notice - Why the dictation stops on its own, if it does.
   */
  #stopListening(notice: DictationNotice | undefined): void {
    const state = this.#state
    if (state.phase !== "listening") return
    state.recorder.stop()
    state.session.socket.sendStop()
    const timer = setTimeout(() => {
      this.#closeDictation(this.#notice)
    }, FINAL_TEXT_WAIT_MS)
    this.#notice = notice
    this.#state = { phase: "stopping", session: state.session, timer }
    this.#sendView()
  }

  /**
   * Writes a text message of the socket into the draft, and ends the
   * dictation on the final one.
   *
   * @param signal - Signal of the dictation the message belongs to.
   * @param text - The message, as the backend sent it.
   */
  #handleText(signal: AbortSignal, text: string): void {
    const state = this.#state
    if (signal.aborted || state.phase === "idle") return
    const message = parseServerMessage(text)
    if (message === undefined) {
      this.#closeDictation("stopped")
      return
    }
    state.session.draft = buildDictatedDraft(state.session.anchor, message.text)
    this.#deps.updateDraft(state.session.draft)
    if (message.type === "final") this.#closeDictation(this.#notice)
  }

  /**
   * Ends the dictation whose socket closed before its final text.
   *
   * @param signal - Signal of the dictation the socket belongs to.
   * @param code - The socket's close code.
   */
  #handleClose(signal: AbortSignal, code: number): void {
    if (signal.aborted) return
    this.#closeDictation(findCloseNotice(code) ?? this.#notice)
  }

  /**
   * Closes the running dictation: releases the microphone, the timer, and
   * the socket, and sends the idle view.
   *
   * @param notice - Why the dictation ended on its own, if it did.
   */
  #closeDictation(notice: DictationNotice | undefined): void {
    const state = this.#state
    if (state.phase === "idle") return
    this.#state = { phase: "idle" }
    this.#notice = notice
    state.session.abort.abort()
    if (state.phase === "listening") state.recorder.stop()
    if (state.phase === "stopping") clearTimeout(state.timer)
    state.session.socket.close()
    this.#sendView()
  }

  /** Sends what the composer shows to the view's receiver. */
  #sendView(): void {
    const state = this.#state
    this.#deps.onViewChange({
      status: state.phase,
      notice: this.#notice,
      isAtDraftEnd:
        state.phase !== "idle" && state.session.anchor.after.trim() === ""
    })
  }
}
