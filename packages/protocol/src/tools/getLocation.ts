import { hasSavedLocationPart, locationSettingsSchema } from "@lys/share"
import * as z from "zod"
import { buildCodeOnlyFailureSchema } from "./_share"

/**
 * Validates the argument object of a `get_location` call: the tool takes no
 * arguments, so only an empty object passes.
 *
 * @remarks The desktop command takes no arguments; unknown keys are rejected
 * here, because the desktop would ignore them instead of reporting them.
 */
export const getLocationInputSchema = z.strictObject({}).readonly()

/**
 * Validates the result of the desktop `get_location` command: the location
 * the person saved in Settings.
 *
 * @remarks It has the shape of the `location` settings group, and at least
 * one part is a place name: without one, the desktop declares
 * `locationNotSet` instead. The location is personal data.
 */
export const savedLocationSchema = locationSettingsSchema.refine(
  hasSavedLocationPart,
  "A saved location has a city, a region, or a country."
)

/** Location the desktop `get_location` command returns; personal data. */
export type SavedLocation = z.infer<typeof savedLocationSchema>

/**
 * Validates a failure that the desktop `get_location` command declares.
 *
 * @remarks This mirrors the desktop's serialized failure. No failure carries
 * the settings path or an operating-system message. Adding a code is a
 * compatibility change for consumers that branch exhaustively.
 */
export const getLocationErrorSchema = z.discriminatedUnion("code", [
  buildCodeOnlyFailureSchema({
    /** The person saved no location. */
    code: z.literal("locationNotSet")
  }),
  buildCodeOnlyFailureSchema({
    /** The settings file exists but cannot be read or parsed. */
    code: z.literal("settingsUnreadable")
  })
])

/** Failure that the desktop `get_location` command declares. */
export type GetLocationError = z.infer<typeof getLocationErrorSchema>
