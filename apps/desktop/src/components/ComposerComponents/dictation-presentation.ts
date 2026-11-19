import type { DictationNotice, DictationStatus } from "@/lib/dictation"

/** What the dictation button reads to decide what it offers. */
export type DictationButtonSituation = Readonly<{
  /** Where the dictation stands. */
  status: DictationStatus
  /**
   * Whether the message field is off: the model cannot answer, the agent was
   * deleted, or the conversation is a job.
   */
  isFieldOff: boolean
  /** Whether a stored conversation is being read to replace the shown one. */
  isOpeningConversation: boolean
  /** Whether voice runs, so Lys can listen. */
  isVoiceRunning: boolean
  /** Whether Lys is answering or talking. */
  isLysBusy: boolean
}>

/**
 * What the dictation button offers.
 *
 * @remarks `ready`: a press starts a dictation. `listening`: a dictation
 * starts or listens, and a press stops it. `unavailable`: the button is off,
 * with the reason to say when there is one; the wait for a dictation's final
 * text and the opening of a conversation give none, because they pass on
 * their own.
 */
export type DictationButtonState =
  | Readonly<{
      /** A press starts a dictation. */
      kind: "ready"
    }>
  | Readonly<{
      /** A press stops the dictation. */
      kind: "listening"
    }>
  | Readonly<{
      /** The button is off. */
      kind: "unavailable"
      /** Why, as one sentence, or undefined when the reason passes on its own. */
      reason: string | undefined
    }>

/** Why the button is off while the message field is. */
const FIELD_OFF_REASON = "The message field is off."

/** Why the button is off while voice does not run. */
const VOICE_STOPPED_REASON = "Start voice in Settings to talk."

/** Why the button is off while Lys answers or talks. */
const LYS_BUSY_REASON = "Wait for Lys to finish."

/** What the composer says for each way a dictation ends on its own. */
const DICTATION_NOTICE_SENTENCES = Object.freeze({
  "voice-not-ready": "voice isn't ready yet.",
  "microphone-denied":
    "Lys can't use the microphone. Allow it in System Settings → Privacy & Security → Microphone.",
  "microphone-missing": "No microphone found.",
  "microphone-failed": "The microphone could not be started.",
  "voice-stopped": "Listening stopped because voice stopped.",
  stopped: "Listening stopped."
} satisfies Readonly<Record<DictationNotice, string>>)

/**
 * Finds why a dictation cannot start while none runs.
 *
 * @param situation - What the button reads.
 * @returns The first reason that applies: the field is off, a conversation
 * is opening, voice does not run, or Lys is busy; `null` when a dictation
 * can start. A conversation that opens gives `undefined`, a reason not said.
 */
function findStartRefusal(
  situation: DictationButtonSituation
): string | undefined | null {
  if (situation.isFieldOff) return FIELD_OFF_REASON
  if (situation.isOpeningConversation) return undefined
  if (!situation.isVoiceRunning) return VOICE_STOPPED_REASON
  return situation.isLysBusy ? LYS_BUSY_REASON : null
}

/**
 * Determines what the dictation button offers.
 *
 * @param situation - Where the dictation stands, and what could keep one
 * from starting.
 * @returns `listening` while a dictation starts or listens, whatever else
 * holds, so it can always be stopped; `unavailable` without a reason while
 * its final text is awaited; otherwise `unavailable` with the first reason a
 * dictation cannot start, or `ready`.
 */
export function calculateDictationButtonState(
  situation: DictationButtonSituation
): DictationButtonState {
  if (situation.status === "starting" || situation.status === "listening") {
    return { kind: "listening" }
  }
  if (situation.status === "stopping") {
    return { kind: "unavailable", reason: undefined }
  }
  const reason = findStartRefusal(situation)
  return reason === null ? { kind: "ready" } : { kind: "unavailable", reason }
}

/**
 * Formats why the last dictation ended on its own.
 *
 * @param notice - The dictation's notice, or undefined when it has none.
 * @returns One sentence, or an empty string without a notice.
 */
export function formatDictationNotice(
  notice: DictationNotice | undefined
): string {
  return notice === undefined ? "" : DICTATION_NOTICE_SENTENCES[notice]
}
