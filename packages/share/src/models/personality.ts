import * as z from "zod"

/**
 * Validates the side of Lys's personality that answers a chat turn.
 *
 * @remarks `dark` is Caliginia, active through the night, and `light` is
 * Lysiptera, active through the day. The desktop host selects the side from
 * its local time, the desktop sends it with each chat request, and the backend
 * selects the matching tone prompt. Adding a side is a compatibility change
 * for every exhaustive consumer.
 */
export const lysPersonalitySchema = z.enum(["dark", "light"])

/**
 * Validates one continuous span of local time during which a single side of
 * Lys is active, as reported by the desktop host.
 *
 * @remarks Every reading taken within the same span is equal, so consumers
 * compare periods with {@link isSameLysPersonalityPeriod} to recognize that
 * the side changed, including while the application was closed. Unknown
 * fields are rejected.
 */
export const lysPersonalityPeriodSchema = z
  .strictObject({
    /** Side active throughout the period. */
    personality: lysPersonalitySchema,
    /**
     * Local calendar date, `YYYY-MM-DD`, on which the period began. A dark
     * period keeps the date of the evening on which it began after midnight.
     */
    startDate: z.iso.date()
  })
  .readonly()

/** Side of Lys's personality accepted by {@link lysPersonalitySchema}. */
export type LysPersonality = z.infer<typeof lysPersonalitySchema>

/** Span of one active side accepted by {@link lysPersonalityPeriodSchema}. */
export type LysPersonalityPeriod = z.infer<typeof lysPersonalityPeriodSchema>

/**
 * Checks whether two readings belong to the same period of Lys's personality.
 *
 * @param firstPeriod - One validated period reading.
 * @param secondPeriod - Another validated period reading.
 * @returns Whether both readings name the same side and start date.
 */
export function isSameLysPersonalityPeriod(
  firstPeriod: LysPersonalityPeriod,
  secondPeriod: LysPersonalityPeriod
): boolean {
  return (
    firstPeriod.personality === secondPeriod.personality &&
    firstPeriod.startDate === secondPeriod.startDate
  )
}
