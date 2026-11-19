import { describe, expect, it } from "vitest"
import {
  calculateDictationButtonState,
  formatDictationNotice,
  type DictationButtonSituation
} from "@/components/ComposerComponents/dictation-presentation"

/** A situation in which a dictation can start. */
const READY_SITUATION: DictationButtonSituation = Object.freeze({
  status: "idle",
  isFieldOff: false,
  isOpeningConversation: false,
  isVoiceRunning: true,
  isLysBusy: false
})

/** A situation in which everything that can keep a dictation from starting does. */
const BLOCKED_SITUATION: DictationButtonSituation = Object.freeze({
  status: "idle",
  isFieldOff: true,
  isOpeningConversation: true,
  isVoiceRunning: false,
  isLysBusy: true
})

describe("calculateDictationButtonState", () => {
  it("is ready while voice runs and nothing keeps Lys from listening", () => {
    expect(calculateDictationButtonState(READY_SITUATION)).toEqual({
      kind: "ready"
    })
  })

  it.each(["starting", "listening"] as const)(
    "offers the stop while a dictation is %s, whatever else holds",
    (status) => {
      expect(
        calculateDictationButtonState({ ...BLOCKED_SITUATION, status })
      ).toEqual({ kind: "listening" })
    }
  )

  it("is off without a reason while the final text is awaited", () => {
    expect(
      calculateDictationButtonState({ ...READY_SITUATION, status: "stopping" })
    ).toEqual({ kind: "unavailable", reason: undefined })
  })

  it.each([
    [{ isVoiceRunning: false }, "Start voice in Settings to talk."],
    [{ isLysBusy: true }, "Wait for Lys to finish."],
    [{ isFieldOff: true }, "The message field is off."],
    [{ isOpeningConversation: true }, undefined]
  ])("is off for %j with the reason %j", (change, reason) => {
    expect(
      calculateDictationButtonState({ ...READY_SITUATION, ...change })
    ).toEqual({ kind: "unavailable", reason })
  })

  it("names the field first, then an opening conversation, then voice, then Lys", () => {
    const reasons = [
      BLOCKED_SITUATION,
      { ...BLOCKED_SITUATION, isFieldOff: false },
      { ...BLOCKED_SITUATION, isFieldOff: false, isOpeningConversation: false },
      { ...READY_SITUATION, isLysBusy: true }
    ].map((situation) => calculateDictationButtonState(situation))

    expect(reasons).toEqual([
      { kind: "unavailable", reason: "The message field is off." },
      { kind: "unavailable", reason: undefined },
      { kind: "unavailable", reason: "Start voice in Settings to talk." },
      { kind: "unavailable", reason: "Wait for Lys to finish." }
    ])
  })
})

describe("formatDictationNotice", () => {
  it.each([
    ["voice-not-ready", "voice isn't ready yet."],
    [
      "microphone-denied",
      "Lys can't use the microphone. Allow it in System Settings → Privacy & Security → Microphone."
    ],
    ["microphone-missing", "No microphone found."],
    ["microphone-failed", "The microphone could not be started."],
    ["voice-stopped", "Listening stopped because voice stopped."],
    ["stopped", "Listening stopped."]
  ] as const)("says the sentence of %s", (notice, sentence) => {
    expect(formatDictationNotice(notice)).toBe(sentence)
  })

  it("says nothing without a notice", () => {
    expect(formatDictationNotice(undefined)).toBe("")
  })
})
