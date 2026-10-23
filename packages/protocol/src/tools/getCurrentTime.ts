import * as z from "zod"
import { buildCodeOnlyFailureSchema } from "./_share"

/**
 * Finds an offset from UTC as `+HH:MM`, or `+HH:MM:SS` for an offset with
 * seconds, which only historical times have.
 */
const UTC_OFFSET_PATTERN = /^[+-]\d{2}:\d{2}(?::\d{2})?$/

/**
 * Finds a local date and time to the second followed by its offset from UTC,
 * such as `2026-10-22T21:30:05+02:00`.
 */
const LOCAL_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}(?::\d{2})?$/

/**
 * Validates the argument object of a `get_current_time` call: the tool takes
 * no arguments, so only an empty object passes.
 *
 * @remarks The desktop command takes no arguments; unknown keys are rejected
 * here, because the desktop would ignore them instead of reporting them.
 */
export const getCurrentTimeInputSchema = z.strictObject({}).readonly()

/**
 * Validates the result of the desktop `get_current_time` command: the local
 * date, time, and time zone of the machine running the desktop app.
 *
 * @remarks This mirrors the desktop's serialized `CurrentTime`. The schema is
 * strict, so a result with any other key is rejected.
 */
export const currentTimeSchema = z
  .strictObject({
    /**
     * Local date and time to the second, then the UTC offset, such as
     * `2026-10-22T21:30:05+02:00`; fractions of a second are dropped.
     */
    dateTime: z.string().regex(LOCAL_DATE_TIME_PATTERN),
    /** English name of the local weekday. */
    weekday: z.enum([
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday"
    ]),
    /** Offset of local time from UTC; UTC itself is `+00:00`. */
    utcOffset: z.string().regex(UTC_OFFSET_PATTERN),
    /**
     * IANA name of the machine's time zone, such as `Europe/Paris`, or `null`
     * when the zone has none, as for a zone a POSIX `TZ` rule sets.
     */
    timeZone: z.string().min(1).nullable()
  })
  .readonly()

/** Local date, time, and time zone the desktop `get_current_time` command returns. */
export type CurrentTime = z.infer<typeof currentTimeSchema>

/**
 * Validates a failure that the desktop `get_current_time` command declares.
 *
 * @remarks This mirrors the desktop's serialized failure. Adding a code is a
 * compatibility change for consumers that branch exhaustively.
 */
export const getCurrentTimeErrorSchema = z.discriminatedUnion("code", [
  buildCodeOnlyFailureSchema({
    /**
     * The machine's time zone could not be determined, so no time was
     * returned; the desktop never assumes UTC instead.
     */
    code: z.literal("timeZoneUnknown")
  })
])

/** Failure that the desktop `get_current_time` command declares. */
export type GetCurrentTimeError = z.infer<typeof getCurrentTimeErrorSchema>
