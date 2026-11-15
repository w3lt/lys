import { locationSettingsSchema } from "@lys/share"
import { describe, expect, it } from "vitest"
import {
  estimateEveryRequestTokens,
  formatAboutYouSummary,
  formatAskedLocation,
  formatEveryRequestList,
  formatLocationSummary,
  formatModelViewSummary,
  formatNotesHelp,
  formatNotesSummary,
  formatPersonDisplayName,
  formatPreferencesPreview,
  formatPreferencesSummary
} from "@/components/SettingsViewComponents/profile-presentation"
import type {
  NotesForLys,
  PersonIdentity,
  WritingPreferences
} from "@/lib/store/local-profile"

/** A person with a name, the name Lys calls them, and pronouns. */
const ADA: PersonIdentity = {
  name: "Ada Lovelace",
  callName: "Ada",
  pronouns: "she/her",
  reads: "English, French"
}

/** A person who has not said who they are. */
const NOBODY: PersonIdentity = {
  name: " ",
  callName: "",
  pronouns: "",
  reads: "English"
}

/** Notes of 41 characters, about 11 tokens, sent with every request. */
const SENT_NOTES: NotesForLys = {
  text: "Keep answers short; I work in Rust daily.",
  isSentWithEveryRequest: true
}

/** The notes kept but not sent. */
const KEPT_NOTES: NotesForLys = { ...SENT_NOTES, isSentWithEveryRequest: false }

/** Empty notes. */
const NO_NOTES: NotesForLys = { text: "", isSentWithEveryRequest: true }

/** A city and a country saved, no region. */
const LYON = locationSettingsSchema.parse({
  city: "Lyon",
  region: null,
  country: "France"
})

/** No location saved. */
const NOWHERE = locationSettingsSchema.parse({
  city: null,
  region: null,
  country: null
})

/** Preferences written the American way. */
const AMERICAN: WritingPreferences = {
  units: "imperial",
  temperature: "fahrenheit",
  dates: "month-day-year",
  clock: "12-hour",
  week: "sunday"
}

/** Preferences written the European way, with ISO dates. */
const EUROPEAN: WritingPreferences = {
  units: "metric",
  temperature: "celsius",
  dates: "iso",
  clock: "24-hour",
  week: "monday"
}

describe("formatPersonDisplayName", () => {
  it("prefers what Lys calls the person, then their name, then you", () => {
    expect(formatPersonDisplayName(ADA)).toBe("Ada")
    expect(formatPersonDisplayName({ ...ADA, callName: " " })).toBe(
      "Ada Lovelace"
    )
    expect(formatPersonDisplayName(NOBODY)).toBe("you")
  })
})

describe("estimateEveryRequestTokens", () => {
  it("adds the notes, with their frame, only while they are sent and not empty", () => {
    const withoutNotes = estimateEveryRequestTokens(ADA, NO_NOTES)

    expect(estimateEveryRequestTokens(ADA, KEPT_NOTES)).toBe(withoutNotes)
    expect(estimateEveryRequestTokens(ADA, SENT_NOTES)).toBe(withoutNotes + 17)
  })

  it("grows with the identity's text", () => {
    expect(estimateEveryRequestTokens(ADA, NO_NOTES)).toBeGreaterThan(
      estimateEveryRequestTokens(NOBODY, NO_NOTES)
    )
  })
})

describe("formatEveryRequestList", () => {
  it("names the pronouns and the notes only when they are sent", () => {
    expect(formatEveryRequestList(ADA, SENT_NOTES)).toBe(
      "Your name, pronouns, languages and preferences, and your notes."
    )
    expect(formatEveryRequestList(NOBODY, KEPT_NOTES)).toBe(
      "Your name, languages and preferences."
    )
  })
})

describe("location summaries", () => {
  it("gives the most precise saved part when a model asks, or nothing", () => {
    expect(formatAskedLocation(LYON)).toBe("Lyon")
    expect(formatAskedLocation(NOWHERE)).toBe("Nothing")
  })

  it("says whether the location is shared when asked, after the tokens", () => {
    expect(formatModelViewSummary(42, LYON)).toBe(
      "~42 tokens with every request · location only when asked"
    )
    expect(formatModelViewSummary(42, NOWHERE)).toBe(
      "~42 tokens with every request · location never shared"
    )
  })

  it("summarizes the saved parts and their precision, or that none is saved", () => {
    expect(formatLocationSummary(LYON)).toBe(
      "Lyon, France · shared down to city"
    )
    expect(formatLocationSummary(NOWHERE)).toBe("Nothing saved yet")
  })
})

describe("formatAboutYouSummary", () => {
  it("joins what Lys calls the person with the parts that are not blank", () => {
    expect(formatAboutYouSummary(ADA)).toBe("Ada · she/her · English, French")
    expect(formatAboutYouSummary(NOBODY)).toBe("you · English")
  })
})

describe("preferences", () => {
  it("summarizes each choice in a few words", () => {
    expect(formatPreferencesSummary(AMERICAN)).toBe(
      "Imperial · °F · 11/14/2026 · 12-hour · weeks from Sunday"
    )
    expect(formatPreferencesSummary(EUROPEAN)).toBe(
      "Metric · °C · 2026-11-14 · 24-hour · weeks from Monday"
    )
  })

  it("previews a sentence written with each choice", () => {
    expect(formatPreferencesPreview(AMERICAN)).toBe(
      "Dates like 11/14/2026 at 5:05 pm, distances in miles, weather in °F, weeks from Sunday."
    )
    expect(formatPreferencesPreview(EUROPEAN)).toBe(
      "Dates like 2026-11-14 at 17:05, distances in kilometres, weather in °C, weeks from Monday."
    )
  })
})

describe("notes", () => {
  it("summarizes the notes' length and whether they are sent", () => {
    expect(formatNotesSummary(SENT_NOTES)).toBe(
      "41 characters · sent with every request"
    )
    expect(
      formatNotesSummary({ text: "", isSentWithEveryRequest: false })
    ).toBe("No notes yet · not sent")
  })

  it("says what the notes add to a request", () => {
    expect(formatNotesHelp(SENT_NOTES)).toBe("~17 tokens with every request.")
    expect(formatNotesHelp(NO_NOTES)).toBe(
      "Empty notes add nothing to a request."
    )
    expect(formatNotesHelp(KEPT_NOTES)).toBe(
      "Kept here, not sent. Switch it on to add it to every request."
    )
  })
})
