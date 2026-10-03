import {
  lysPersonalityPeriodSchema,
  type LysPersonalityPeriod
} from "@lys/share"
import { invoke } from "@tauri-apps/api/core"

/**
 * Reads the period of Lys's personality that contains the desktop host's
 * current local time.
 *
 * @returns The period the host reported, after validation against the shared
 * period contract.
 * @throws The Tauri invoke rejection when the host cannot report a period, or
 * a `ZodError` when the reported value does not satisfy the contract.
 * @remarks The host reads its clock and time zone on every call, so repeated
 * calls observe a side change.
 */
export async function getLysPersonalityPeriod(): Promise<LysPersonalityPeriod> {
  const reportedPeriod = await invoke<unknown>("get_lys_personality_period")

  return lysPersonalityPeriodSchema.parse(reportedPeriod)
}
