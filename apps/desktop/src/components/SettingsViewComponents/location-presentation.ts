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

/**
 * How precisely the location is shared: down to the city, the region, or
 * the country, or not at all.
 */
export type LocationPrecision = "city" | "region" | "country" | "none"

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

/** Precisions in the order the card offers them, with their labels. */
export const LOCATION_PRECISIONS: readonly {
  readonly precision: LocationPrecision
  readonly label: string
}[] = Object.freeze([
  { precision: "city", label: "City" },
  { precision: "region", label: "Region" },
  { precision: "country", label: "Country" },
  { precision: "none", label: "Nothing" }
])

/** How many parts, from the country up, each precision keeps. */
const PRECISION_DEPTHS = Object.freeze({
  city: 3,
  region: 2,
  country: 1,
  none: 0
} satisfies Readonly<Record<LocationPrecision, number>>)

/** How many parts, from the country up, a precision must keep to keep a part. */
const PART_DEPTHS = Object.freeze({
  city: 3,
  region: 2,
  country: 1
} satisfies Readonly<Record<LocationPart, number>>)

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
 * Answers whether a precision shares a part.
 *
 * @param part - The part.
 * @param precision - How precisely the location is shared.
 * @returns True when the part is at or above the precision.
 */
function isPartShared(
  part: LocationPart,
  precision: LocationPrecision
): boolean {
  return PART_DEPTHS[part] <= PRECISION_DEPTHS[precision]
}

/**
 * Finds how precisely the location is shared once a field's text changed.
 *
 * @param precision - How precisely the location was shared.
 * @param part - The part whose field changed.
 * @param text - The field's new text.
 * @returns The part, when the text is not blank and the part was below the
 * precision, so what the person types is shared; the precision otherwise.
 */
export function raiseLocationPrecision(
  precision: LocationPrecision,
  part: LocationPart,
  text: string
): LocationPrecision {
  if (text.trim() === "" || isPartShared(part, precision)) return precision
  return part
}

/**
 * Finds how precisely a saved location is shared.
 *
 * @param location - Saved location.
 * @returns The most precise part saved; `city` while nothing is saved, so
 * a new location is shared down to its city unless the person chooses
 * otherwise.
 */
export function findLocationPrecision(
  location: LocationSettings
): LocationPrecision {
  if (location.city !== null) return "city"
  if (location.region !== null) return "region"
  if (location.country !== null) return "country"
  return "city"
}

/**
 * Formats what `get_location` would return once the fields are saved.
 *
 * @param draftParse - Outcome of reading the fields.
 * @param savedLocation - Location saved in the settings file.
 * @returns The saved parts joined by commas, in quotes; that nothing is
 * shared while no part would be saved; or that the marked field must be
 * fixed first.
 */
export function formatLocationPreview(
  draftParse: LocationDraftParse,
  savedLocation: LocationSettings
): string {
  if (draftParse.status === "invalid")
    return "Nothing until the marked field is fixed."
  const location =
    draftParse.status === "changed" ? draftParse.location : savedLocation
  const parts = LOCATION_PARTS.flatMap((part) => location[part] ?? [])
  return parts.length === 0
    ? "Nothing: get_location fails until a location is saved."
    : `"${parts.join(", ")}"`
}

/**
 * Reads the fields as a location to save.
 *
 * @param draft - Text in each field.
 * @param savedLocation - Location saved in the settings file.
 * @param precision - How precisely the location is shared; a part below
 * it is not saved.
 * @returns `invalid` with each field's problem when any trimmed field is not
 * a place name; otherwise `changed` with the location, a blank field or a
 * part below the precision as null, when it differs from the saved one, or
 * `unchanged`. Surrounding whitespace is the only change made to the text.
 */
export function parseLocationDraft(
  draft: LocationDraft,
  savedLocation: LocationSettings,
  precision: LocationPrecision
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
    else if (isPartShared(part, precision)) location[part] = parsed.name
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
 * @returns, in order of precedence: a running or failed save, which keeps
 * the edit it saves; what an edit means (invalid, or unsaved with how to
 * save or discard, naming a removal as one); then whether a location is
 * saved.
 */
export function formatLocationMessage(
  input: LocationStatusInput
): LocationMessage {
  const { draftParse, saveState } = input
  if (saveState.status === "saving") return { text: "saving…", tone: "pending" }
  if (saveState.status === "failed")
    return { text: saveState.error, tone: "danger" }
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
  return hasSavedLocationPart(input.savedLocation)
    ? SAVED_LOCATION_MESSAGE
    : NO_LOCATION_MESSAGE
}
