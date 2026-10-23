import { hasSavedLocationPart, locationSettingsSchema } from "@lys/share"
import { describe, expect, it } from "vitest"
import {
  buildLocationDraft,
  formatLocationMessage,
  formatPlaceNameProblem,
  parseLocationDraft
} from "@/components/SettingsViewComponents/location-presentation"

/** Location saved on disk: a city and a country, no region. */
const SAVED_LOCATION = locationSettingsSchema.parse({
  city: "Lyon",
  region: null,
  country: "France"
})

/** Location whose parts are all null: none saved. */
const NO_LOCATION = locationSettingsSchema.parse({
  city: null,
  region: null,
  country: null
})

describe("buildLocationDraft", () => {
  it("shows each saved name and leaves a part not saved empty", () => {
    expect(buildLocationDraft(SAVED_LOCATION)).toEqual({
      city: "Lyon",
      region: "",
      country: "France"
    })
  })
})

describe("hasSavedLocationPart", () => {
  it("answers whether any part is saved", () => {
    expect(hasSavedLocationPart(SAVED_LOCATION)).toBe(true)
    expect(hasSavedLocationPart(NO_LOCATION)).toBe(false)
  })
})

describe("parseLocationDraft", () => {
  it("reads trimmed fields as a changed location, a blank field as null", () => {
    const draft = { city: "  Villeurbanne ", region: "\t", country: "France" }

    expect(parseLocationDraft(draft, SAVED_LOCATION)).toEqual({
      status: "changed",
      location: { city: "Villeurbanne", region: null, country: "France" }
    })
  })

  it("reads the saved location again, padded or not, as unchanged", () => {
    const draft = { city: "Lyon ", region: "", country: " France" }

    expect(parseLocationDraft(draft, SAVED_LOCATION)).toEqual({
      status: "unchanged"
    })
  })

  it("reads every field emptied as a change that removes the location", () => {
    const draft = { city: "", region: "", country: "" }

    expect(parseLocationDraft(draft, SAVED_LOCATION)).toEqual({
      status: "changed",
      location: NO_LOCATION
    })
  })

  it("names the problem of each field that is not a place name", () => {
    const draft = { city: "é".repeat(101), region: "Rhône\tAlpes", country: "" }

    expect(parseLocationDraft(draft, SAVED_LOCATION)).toEqual({
      status: "invalid",
      problems: { city: "tooLong", region: "controlCharacter" }
    })
  })

  it("counts characters, not UTF-16 units, against the limit", () => {
    const draft = { city: "🏙".repeat(100), region: "", country: "" }

    expect(parseLocationDraft(draft, NO_LOCATION)).toMatchObject({
      status: "changed"
    })
  })
})

describe("formatPlaceNameProblem", () => {
  it("says what each problem asks the person to change", () => {
    expect(formatPlaceNameProblem("tooLong")).toBe(
      "Use at most 100 characters."
    )
    expect(formatPlaceNameProblem("controlCharacter")).toBe(
      "Remove tabs, line breaks, and other control characters."
    )
  })
})

describe("formatLocationMessage", () => {
  it.each([
    [
      "a running save, over the edit it saves,",
      { status: "changed", location: NO_LOCATION },
      { status: "saving" },
      { text: "saving…", tone: "pending" }
    ],
    [
      "a failed save, over the edit it kept,",
      { status: "changed", location: NO_LOCATION },
      { status: "failed", error: "Lys couldn't write your location." },
      { text: "Lys couldn't write your location.", tone: "danger" }
    ],
    [
      "a failed save, over an invalid edit,",
      { status: "invalid", problems: { city: "tooLong" } },
      { status: "failed", error: "Lys couldn't write your location." },
      { text: "Lys couldn't write your location.", tone: "danger" }
    ],
    [
      "an invalid edit",
      { status: "invalid", problems: { city: "tooLong" } },
      { status: "saved" },
      { text: "can't save yet · fix the marked field", tone: "danger" }
    ],
    [
      "an unsaved edit",
      { status: "changed", location: SAVED_LOCATION },
      { status: "saved" },
      { text: "unsaved · enter to save, esc to discard", tone: "attention" }
    ],
    [
      "an unsaved removal",
      { status: "changed", location: NO_LOCATION },
      { status: "idle" },
      {
        text: "unsaved · enter to remove your location, esc to discard",
        tone: "attention"
      }
    ]
  ] as const)(
    "puts %s before the saved location",
    (_label, draftParse, saveState, message) => {
      expect(
        formatLocationMessage({
          savedLocation: SAVED_LOCATION,
          draftParse,
          saveState
        })
      ).toEqual(message)
    }
  )

  it("says whether a location is saved once nothing else needs saying", () => {
    const unchanged = { status: "unchanged" } as const
    const saved = { status: "saved" } as const

    expect(
      formatLocationMessage({
        savedLocation: SAVED_LOCATION,
        draftParse: unchanged,
        saveState: saved
      })
    ).toEqual({
      text: "saved · a model gets it only by calling get_location",
      tone: "muted"
    })
    expect(
      formatLocationMessage({
        savedLocation: NO_LOCATION,
        draftParse: unchanged,
        saveState: saved
      })
    ).toEqual({
      text: "No location saved. get_location fails until you save one.",
      tone: "muted"
    })
  })
})
