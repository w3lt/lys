import { hasSavedLocationPart, locationSettingsSchema } from "@lys/share"
import { describe, expect, it } from "vitest"
import {
  buildLocationDraft,
  findLocationPrecision,
  raiseLocationPrecision,
  formatLocationMessage,
  formatLocationPreview,
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

    expect(parseLocationDraft(draft, SAVED_LOCATION, "city")).toEqual({
      status: "changed",
      location: { city: "Villeurbanne", region: null, country: "France" }
    })
  })

  it("reads the saved location again, padded or not, as unchanged", () => {
    const draft = { city: "Lyon ", region: "", country: " France" }

    expect(parseLocationDraft(draft, SAVED_LOCATION, "city")).toEqual({
      status: "unchanged"
    })
  })

  it("reads every field emptied as a change that removes the location", () => {
    const draft = { city: "", region: "", country: "" }

    expect(parseLocationDraft(draft, SAVED_LOCATION, "city")).toEqual({
      status: "changed",
      location: NO_LOCATION
    })
  })

  it("names the problem of each field that is not a place name", () => {
    const draft = { city: "é".repeat(101), region: "Rhône\tAlpes", country: "" }

    expect(parseLocationDraft(draft, SAVED_LOCATION, "city")).toEqual({
      status: "invalid",
      problems: { city: "tooLong", region: "controlCharacter" }
    })
  })

  it("leaves out the parts below the precision", () => {
    const draft = { city: "Lyon", region: "Rhône", country: "France" }

    expect(parseLocationDraft(draft, SAVED_LOCATION, "country")).toEqual({
      status: "changed",
      location: { city: null, region: null, country: "France" }
    })
  })

  it("reads sharing nothing as a change that removes the location", () => {
    const draft = { city: "Lyon", region: "", country: "France" }

    expect(parseLocationDraft(draft, SAVED_LOCATION, "none")).toEqual({
      status: "changed",
      location: NO_LOCATION
    })
  })

  it("still names the problem of a field below the precision", () => {
    const draft = { city: "Ly\non", region: "", country: "France" }

    expect(parseLocationDraft(draft, SAVED_LOCATION, "country")).toEqual({
      status: "invalid",
      problems: { city: "controlCharacter" }
    })
  })

  it("counts characters, not UTF-16 units, against the limit", () => {
    const draft = { city: "🏙".repeat(100), region: "", country: "" }

    expect(parseLocationDraft(draft, NO_LOCATION, "city")).toMatchObject({
      status: "changed"
    })
  })
})

describe("findLocationPrecision", () => {
  it.each([
    ["the city", { city: "Lyon", country: "France" }, "city"],
    ["the region", { region: "Rhône", country: "France" }, "region"],
    ["the country", { country: "France" }, "country"],
    ["nothing, as the city", {}, "city"]
  ])("finds %s as the precision", (_label, parts, precision) => {
    const location = locationSettingsSchema.parse({ ...NO_LOCATION, ...parts })

    expect(findLocationPrecision(location)).toBe(precision)
  })
})

describe("raiseLocationPrecision", () => {
  it("shares a part typed below the precision, and keeps the precision otherwise", () => {
    expect(raiseLocationPrecision("country", "city", "Paris")).toBe("city")
    expect(raiseLocationPrecision("none", "region", "Rhône")).toBe("region")
    expect(raiseLocationPrecision("country", "city", "  ")).toBe("country")
    expect(raiseLocationPrecision("city", "region", "Rhône")).toBe("city")
  })
})

describe("formatLocationPreview", () => {
  it("quotes the parts a changed location saves", () => {
    const draftParse = {
      status: "changed",
      location: locationSettingsSchema.parse({
        city: null,
        region: "Rhône",
        country: "France"
      })
    } as const

    expect(formatLocationPreview(draftParse, SAVED_LOCATION)).toBe(
      '"Rhône, France"'
    )
  })

  it("quotes the saved location while the fields are unchanged", () => {
    expect(formatLocationPreview({ status: "unchanged" }, SAVED_LOCATION)).toBe(
      '"Lyon, France"'
    )
  })

  it("says nothing is returned while no part would be saved", () => {
    expect(formatLocationPreview({ status: "unchanged" }, NO_LOCATION)).toBe(
      "Nothing: get_location fails until a location is saved."
    )
  })

  it("asks for the marked field first while a field is invalid", () => {
    const draftParse = {
      status: "invalid",
      problems: { city: "tooLong" }
    } as const

    expect(formatLocationPreview(draftParse, SAVED_LOCATION)).toBe(
      "Nothing until the marked field is fixed."
    )
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
