import {
  hasSavedLocationPart,
  MAXIMUM_PLACE_NAME_LENGTH,
  placeNameSchema
} from "@lys/share"

import type { LocationSaveState } from "@/lib/store/location-settings"
import type { LocationSettings } from "@/lib/store/settings"

/** One part of the location the person types. */
export type LocationPart = keyof LocationSettings

/** Text in each field of the location card. */
export type LocationDraft = Readonly<Record<LocationPart, string>>

/** Why one field's text is not a place name. */
export type PlaceNameProblem = "tooLong" | "controlCharacter"

/** Outcome of reading the fields as a location to save. */
export type LocationDraftParse =
  | {
      /** The trimmed fields are a valid location that differs from the saved one. */
      readonly status: "changed"
      /** Location to save; an empty field is null. */
      readonly location: LocationSettings
    }
  | {
      /** The trimmed fields hold the saved location again. */
      readonly status: "unchanged"
    }
  | {
      /** At least one trimmed field is not a place name. */
      readonly status: "invalid"
      /** Problem of each field that is not a place name. */
      readonly problems: Readonly<
        Partial<Record<LocationPart, PlaceNameProblem>>
      >
    }

/** Tone of the card's status line. */
export type LocationTone =
  "muted" | "pending" | "attention" | "success" | "danger"

/** Line under the location fields. */
export type LocationMessage = {
  /** Text of the line. */
  readonly text: string
  /** Tone of the line. */
  readonly tone: LocationTone
}

/** Facts the card's status line describes. */
export type LocationStatusInput = {
  /** Location saved in the settings file. */
  readonly savedLocation: LocationSettings
  /** Outcome of reading the fields. */
  readonly draftParse: LocationDraftParse
  /** Latest save. */
  readonly saveState: LocationSaveState
}

/** Parts in the order the card shows them. */
export const LOCATION_PARTS: readonly LocationPart[] = Object.freeze([
  "city",
  "region",
  "country"
])

/** Label of each part's field. */
export const LOCATION_PART_LABELS = Object.freeze({
  city: "City",
  region: "Region",
  country: "Country"
} satisfies Readonly<Record<LocationPart, string>>)

/**
 * Autofill token of each part's field, so a browser that offers address
 * autofill offers the matching value.
 */
export const LOCATION_PART_AUTOCOMPLETE = Object.freeze({
  city: "address-level2",
  region: "address-level1",
  country: "country-name"
} satisfies Readonly<Record<LocationPart, string>>)

/** Hint stating the constraints of every field, shown before entry. */
export const LOCATION_FIELDS_HINT = `Each field is optional and holds up to ${MAXIMUM_PLACE_NAME_LENGTH} characters.`

/** What each problem asks the person to change. */
const PLACE_NAME_PROBLEM_MESSAGES = Object.freeze({
  tooLong: `Use at most ${MAXIMUM_PLACE_NAME_LENGTH} characters.`,
  controlCharacter: "Remove tabs, line breaks, and other control characters."
} satisfies Readonly<Record<PlaceNameProblem, string>>)

/** Line shown while no location is saved and nothing is edited. */
const NO_LOCATION_MESSAGE: LocationMessage = Object.freeze({
  text: "No location saved. get_location fails until you save one.",
  tone: "muted"
})

/** Line shown while a location is saved and nothing is edited. */
const SAVED_LOCATION_MESSAGE: LocationMessage = Object.freeze({
  text: "saved · a model gets it only by calling get_location",
  tone: "muted"
})

/**
 * Builds the field texts that show a saved location.
 *
 * @param location - Saved location.
 * @returns Each saved name, or an empty text for a part not saved.
 */
export function buildLocationDraft(location: LocationSettings): LocationDraft {
  return {
    city: location.city ?? "",
    region: location.region ?? "",
    country: location.country ?? ""
  }
}

/**
 * Reads one field's text as a part of the location.
 *
 * @param text - Text in the field.
 * @returns The trimmed text as a place name, null for a blank field, or the
 * problem that keeps it from being a place name.
 */
function parseLocationPart(
  text: string
):
  | { readonly status: "parsed"; readonly name: LocationSettings[LocationPart] }
  | { readonly status: "invalid"; readonly problem: PlaceNameProblem } {
  const trimmed = text.trim()
  if (trimmed === "") return { status: "parsed", name: null }
  const parsed = placeNameSchema.safeParse(trimmed)
  if (parsed.success) return { status: "parsed", name: parsed.data }
  return {
    status: "invalid",
    problem:
      [...trimmed].length > MAXIMUM_PLACE_NAME_LENGTH
        ? "tooLong"
        : "controlCharacter"
  }
}

/**
 * Reads the fields as a location to save.
 *
 * @param draft - Text in each field.
 * @param savedLocation - Location saved in the settings file.
 * @returns `invalid` with each field's problem when any trimmed field is not
 * a place name; otherwise `changed` with the location, a blank field as
 * null, when it differs from the saved one, or `unchanged`. Surrounding
 * whitespace is the only change made to the text.
 */
export function parseLocationDraft(
  draft: LocationDraft,
  savedLocation: LocationSettings
): LocationDraftParse {
  const location: Record<LocationPart, LocationSettings[LocationPart]> = {
    city: null,
    region: null,
    country: null
  }
  const problems: Partial<Record<LocationPart, PlaceNameProblem>> = {}
  for (const part of LOCATION_PARTS) {
    const parsed = parseLocationPart(draft[part])
    if (parsed.status === "invalid") problems[part] = parsed.problem
    else location[part] = parsed.name
  }
  if (Object.keys(problems).length > 0) return { status: "invalid", problems }
  const isUnchanged = LOCATION_PARTS.every(
    (part) => location[part] === savedLocation[part]
  )
  return isUnchanged ? { status: "unchanged" } : { status: "changed", location }
}

/**
 * Formats what a field's problem asks the person to change.
 *
 * @param problem - Why the field's text is not a place name.
 * @returns One sentence.
 */
export function formatPlaceNameProblem(problem: PlaceNameProblem): string {
  return PLACE_NAME_PROBLEM_MESSAGES[problem]
}

/**
 * Formats the line under the location fields.
 *
 * @param input - Saved location, the fields, and the latest save.
 * @returns, in order of precedence: what an edit means (invalid, or unsaved
 * with how to save or discard, naming a removal as one); a running or failed
 * save; then whether a location is saved.
 */
export function formatLocationMessage(
  input: LocationStatusInput
): LocationMessage {
  const { draftParse, saveState } = input
  if (draftParse.status === "invalid") {
    return { text: "can't save yet · fix the marked field", tone: "danger" }
  }
  if (draftParse.status === "changed") {
    return {
      text: hasSavedLocationPart(draftParse.location)
        ? "unsaved · enter to save, esc to discard"
        : "unsaved · enter to remove your location, esc to discard",
      tone: "attention"
    }
  }
  if (saveState.status === "saving") return { text: "saving…", tone: "pending" }
  if (saveState.status === "failed")
    return { text: saveState.error, tone: "danger" }
  return hasSavedLocationPart(input.savedLocation)
    ? SAVED_LOCATION_MESSAGE
    : NO_LOCATION_MESSAGE
}
