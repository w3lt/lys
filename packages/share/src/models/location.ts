import * as z from "zod"

/**
 * Most characters, counted as Unicode code points, a place name may have,
 * inclusive.
 *
 * @remarks The settings file never holds a longer name: the desktop host
 * checks the same limit, in its own copy of this rule, when it loads the
 * file. Raising it changes which settings files load and requires a
 * coordinated desktop release.
 */
export const MAXIMUM_PLACE_NAME_LENGTH = 100

/** Finds a control character (Unicode general category Cc), such as a line break. */
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u

/** Finds white space (Unicode White_Space) at the start of a text. */
const LEADING_WHITE_SPACE_PATTERN = /^\p{White_Space}/u

/** Finds white space (Unicode White_Space) at the end of a text. */
const TRAILING_WHITE_SPACE_PATTERN = /\p{White_Space}$/u

/**
 * Answers whether a text follows the place name rule: 1 to
 * {@link MAXIMUM_PLACE_NAME_LENGTH} code points, no control character, and no
 * white space at either end.
 *
 * @param value - Text to inspect, as typed.
 * @returns True when the text is a valid place name.
 */
function isPlaceName(value: string): boolean {
  const length = [...value].length

  return (
    length >= 1 &&
    length <= MAXIMUM_PLACE_NAME_LENGTH &&
    !CONTROL_CHARACTER_PATTERN.test(value) &&
    !LEADING_WHITE_SPACE_PATTERN.test(value) &&
    !TRAILING_WHITE_SPACE_PATTERN.test(value)
  )
}

/**
 * Validates the name of a city, region, or country as the person typed it.
 *
 * @remarks The rule matches the desktop host's `PlaceName`. Parsing never
 * trims or changes the name; a caller that wants trimmed input trims it
 * first. The output is branded, so a checked name cannot stand in for other
 * text. The name is personal data.
 */
export const placeNameSchema = z
  .string()
  .refine(
    isPlaceName,
    `A place name is 1 to ${MAXIMUM_PLACE_NAME_LENGTH} characters, without line breaks or other control characters, and without spaces at either end.`
  )
  .brand<"PlaceName">()

/** Place name that passed {@link placeNameSchema}; personal data. */
export type PlaceName = z.infer<typeof placeNameSchema>

/**
 * Validates the `location` settings group: the location the person saved,
 * as a city, a region, and a country, each a place name or `null`.
 *
 * @remarks A group whose parts are all `null` saves no location. The schema
 * is strict, like the desktop host's group, which rejects unknown fields.
 */
export const locationSettingsSchema = z
  .strictObject({
    /** City, town, or other locality; `null` when not saved. */
    city: placeNameSchema.nullable(),
    /** State, province, or other region; `null` when not saved. */
    region: placeNameSchema.nullable(),
    /** Country; `null` when not saved. */
    country: placeNameSchema.nullable()
  })
  .readonly()

/** Location the person saved, as the `location` settings group holds it. */
export type LocationSettings = z.infer<typeof locationSettingsSchema>

/**
 * Answers whether a location has at least one saved part.
 *
 * @param location - Location to inspect.
 * @returns True when the city, the region, or the country is not `null`.
 */
export function hasSavedLocationPart(location: LocationSettings): boolean {
  return (
    location.city !== null ||
    location.region !== null ||
    location.country !== null
  )
}
