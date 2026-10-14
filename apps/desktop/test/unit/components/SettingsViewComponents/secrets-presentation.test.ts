import type { CheckWebSearchKeyApiResponse } from "@lys/protocol"
import { tavilyApiKeySchema } from "@lys/share"
import { describe, expect, it } from "vitest"
import {
  calculateTavilyKeyBadge,
  calculateTavilyKeyFieldValue,
  formatTavilyKeyMessage,
  formatTavilyKeyPlaceholder,
  parseTavilyKeyDraft,
  type TavilyKeyDraft,
  type TavilyKeyStatusInput
} from "@/components/SettingsViewComponents/secrets-presentation"
import type { TavilyKeyCheckState } from "@/lib/store/secrets-settings"

/** Saved key long enough to show its ends around the mask. */
const SAVED_KEY = tavilyApiKeySchema.parse("tvly-dev-abcdefghij1234")

/** Saved key too short to show any part of. */
const SHORT_KEY = tavilyApiKeySchema.parse("tvly-123456789")

/** Field the person has not edited. */
const UNEDITED: TavilyKeyDraft = Object.freeze({ status: "unedited" })

/**
 * Builds an edit of the key field.
 *
 * @param text - Text in the field.
 * @returns The edited draft.
 */
function buildEditedDraft(text: string): TavilyKeyDraft {
  return { status: "edited", text }
}

/**
 * Builds a check the backend answered.
 *
 * @param outcome - What the backend answered.
 * @returns The checked state.
 */
function buildCheckedState(
  outcome: CheckWebSearchKeyApiResponse
): TavilyKeyCheckState {
  return { status: "checked", outcome }
}

/** Facts of a card with a saved, unedited key, no save, and no check. */
const SAVED_AND_IDLE: TavilyKeyStatusInput = Object.freeze({
  savedApiKey: SAVED_KEY,
  draft: UNEDITED,
  saveState: Object.freeze({ status: "idle" }),
  keyCheck: Object.freeze({ status: "idle" })
})

describe("formatTavilyKeyPlaceholder", () => {
  it("shows an example of a key's start while none is saved", () => {
    expect(formatTavilyKeyPlaceholder(null)).toBe("tvly-…")
  })

  it("masks a saved key, showing its first five and last four characters", () => {
    expect(formatTavilyKeyPlaceholder(SAVED_KEY)).toBe("tvly-••••••••1234")
  })

  it("shows only bullets for a key shorter than 16 characters", () => {
    expect(formatTavilyKeyPlaceholder(SHORT_KEY)).toBe("••••••••")
  })
})

describe("calculateTavilyKeyFieldValue", () => {
  it("shows the edited text whether or not the key is shown", () => {
    expect(
      calculateTavilyKeyFieldValue(buildEditedDraft("tvly-x"), false, SAVED_KEY)
    ).toBe("tvly-x")
  })

  it("shows the saved key only while the person asked to see it", () => {
    expect(calculateTavilyKeyFieldValue(UNEDITED, true, SAVED_KEY)).toBe(
      SAVED_KEY
    )
    expect(calculateTavilyKeyFieldValue(UNEDITED, false, SAVED_KEY)).toBe("")
  })

  it("is empty with nothing saved, even while shown", () => {
    expect(calculateTavilyKeyFieldValue(UNEDITED, true, null)).toBe("")
  })
})

describe("parseTavilyKeyDraft", () => {
  it("finds nothing to save in an unedited field", () => {
    expect(parseTavilyKeyDraft(UNEDITED, SAVED_KEY)).toEqual({
      status: "unchanged"
    })
  })

  it.each([
    ["blank text", " \t "],
    ["the saved key again, with surrounding spaces", `  ${SAVED_KEY} `]
  ])("finds nothing to save in %s", (_label, text) => {
    expect(parseTavilyKeyDraft(buildEditedDraft(text), SAVED_KEY)).toEqual({
      status: "unchanged"
    })
  })

  it("parses a new key, trimming only surrounding whitespace", () => {
    expect(
      parseTavilyKeyDraft(buildEditedDraft("  tvly-new-key\n"), SAVED_KEY)
    ).toEqual({ status: "changed", apiKey: "tvly-new-key" })
  })

  it.each([
    ["a space inside", "tvly-new key"],
    ["a character outside visible ASCII", "tvly-ключ"],
    ["more than 256 characters", `tvly-${"k".repeat(252)}`]
  ])("rejects a key with %s", (_label, text) => {
    expect(parseTavilyKeyDraft(buildEditedDraft(text), null)).toEqual({
      status: "invalid"
    })
  })
})

describe("calculateTavilyKeyBadge", () => {
  it("says no key whatever the last check said", () => {
    expect(
      calculateTavilyKeyBadge(null, buildCheckedState({ status: "rejected" }))
    ).toEqual({ label: "no key", tone: "attention" })
  })

  it.each<[string, TavilyKeyCheckState, string, string]>([
    ["no check", { status: "idle" }, "in use", "success"],
    ["a running check", { status: "checking" }, "in use", "success"],
    [
      "an accepted check",
      buildCheckedState({ status: "accepted", credits: null }),
      "verified",
      "success"
    ],
    [
      "a rejected check",
      buildCheckedState({ status: "rejected" }),
      "rejected",
      "danger"
    ],
    [
      "a check that could not tell",
      buildCheckedState({ status: "failed", reason: "timed-out" }),
      "in use",
      "success"
    ],
    [
      "a check that could not be asked",
      { status: "failed", error: "Lys couldn't reach its backend." },
      "in use",
      "success"
    ]
  ])("shows a saved key after %s as %s", (_label, keyCheck, label, tone) => {
    expect(calculateTavilyKeyBadge(SAVED_KEY, keyCheck)).toEqual({
      label,
      tone
    })
  })
})

describe("formatTavilyKeyMessage", () => {
  it("says no key is saved, and what that means, before anything else happens", () => {
    expect(
      formatTavilyKeyMessage({ ...SAVED_AND_IDLE, savedApiKey: null })
    ).toEqual({
      text: "No key yet. web_search stays unavailable to agents until there is one.",
      tone: "muted"
    })
  })

  it("shows the saved key masked while nothing else is to say", () => {
    expect(formatTavilyKeyMessage(SAVED_AND_IDLE)).toEqual({
      text: "saved · tvly-••••••••1234",
      tone: "muted"
    })
  })

  it("puts an invalid edit first, over a running save", () => {
    expect(
      formatTavilyKeyMessage({
        ...SAVED_AND_IDLE,
        draft: buildEditedDraft("tvly-bad key"),
        saveState: { status: "saving" }
      })
    ).toEqual({
      text: "not a valid key: paste it exactly as Tavily shows it, without spaces",
      tone: "danger"
    })
  })

  it("explains how to save or discard a new key", () => {
    expect(
      formatTavilyKeyMessage({
        ...SAVED_AND_IDLE,
        draft: buildEditedDraft("tvly-new-key")
      })
    ).toEqual({
      text: "unsaved · enter to save, esc to discard",
      tone: "attention"
    })
  })

  it("reports a running save over the latest check", () => {
    expect(
      formatTavilyKeyMessage({
        ...SAVED_AND_IDLE,
        saveState: { status: "saving" },
        keyCheck: buildCheckedState({ status: "rejected" })
      })
    ).toEqual({ text: "saving…", tone: "pending" })
  })

  it("reports a failed save with its caller-safe reason", () => {
    expect(
      formatTavilyKeyMessage({
        ...SAVED_AND_IDLE,
        saveState: { status: "failed", error: "Lys couldn't write the key." }
      })
    ).toEqual({ text: "Lys couldn't write the key.", tone: "danger" })
  })

  it.each<[string, TavilyKeyCheckState, string, string]>([
    ["running", { status: "checking" }, "checking with tavily…", "pending"],
    [
      "accepted with a plan limit",
      buildCheckedState({
        status: "accepted",
        credits: { used: 1_234, limit: 10_000 }
      }),
      "key accepted · 1,234 of 10,000 credits used",
      "success"
    ],
    [
      "accepted without a limit",
      buildCheckedState({
        status: "accepted",
        credits: { used: 5, limit: null }
      }),
      "key accepted · 5 credits used",
      "success"
    ],
    [
      "accepted without credits",
      buildCheckedState({ status: "accepted", credits: null }),
      "key accepted",
      "success"
    ],
    [
      "rejected",
      buildCheckedState({ status: "rejected" }),
      "Tavily rejected this key · check it and save again",
      "danger"
    ],
    [
      "answered that no key is saved",
      buildCheckedState({ status: "unavailable", reason: "api-key-missing" }),
      "No key is saved, so nothing was checked.",
      "danger"
    ],
    [
      "answered that the file's key is invalid",
      buildCheckedState({ status: "unavailable", reason: "api-key-invalid" }),
      "The key in settings.json isn't valid · fix or remove secrets.tavilyApiKey there",
      "danger"
    ],
    [
      "answered that the file is unreadable",
      buildCheckedState({
        status: "unavailable",
        reason: "settings-unreadable"
      }),
      "Lys couldn't read settings.json · fix that file by hand",
      "danger"
    ],
    [
      "limited by Tavily",
      buildCheckedState({ status: "failed", reason: "rate-limited" }),
      "couldn't check the key: Tavily is limiting requests; try again later",
      "danger"
    ],
    [
      "timed out",
      buildCheckedState({ status: "failed", reason: "timed-out" }),
      "couldn't check the key: Tavily didn't answer in time",
      "danger"
    ],
    [
      "unreachable",
      buildCheckedState({ status: "failed", reason: "unreachable" }),
      "couldn't check the key: Tavily couldn't be reached",
      "danger"
    ],
    [
      "answered with a provider error",
      buildCheckedState({ status: "failed", reason: "provider-error" }),
      "couldn't check the key: Tavily answered with an error",
      "danger"
    ],
    [
      "answered unreadably",
      buildCheckedState({ status: "failed", reason: "invalid-response" }),
      "couldn't check the key: Tavily's answer couldn't be read",
      "danger"
    ],
    [
      "not asked",
      { status: "failed", error: "Lys couldn't reach its backend." },
      "couldn't check the key: Lys couldn't reach its backend.",
      "danger"
    ]
  ])("reports a check %s", (_label, keyCheck, text, tone) => {
    expect(formatTavilyKeyMessage({ ...SAVED_AND_IDLE, keyCheck })).toEqual({
      text,
      tone
    })
  })
})
