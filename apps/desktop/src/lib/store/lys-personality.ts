import {
  isSameLysPersonalityPeriod,
  type LysPersonalityPeriod
} from "@lys/share"
import type { StoreApi } from "zustand"
import { getLysPersonalityPeriod } from "@/lib/apis/tauri/personality"

/** Lys personality state and its refresh, composed into the application store. */
export type LysPersonalitySlice = {
  /**
   * Latest period of Lys's personality read from the desktop host.
   *
   * @remarks Absent until application initialization first reads it. A
   * reading of the same period keeps the published value, so subscribers
   * render again only when the side or its start date changes.
   */
  readonly lysPersonalityPeriod: LysPersonalityPeriod | undefined
  /**
   * Reads the current period from the desktop host and publishes it when it
   * differs from the published one.
   *
   * @returns Resolves to the period read, after it is published or found
   * unchanged. A call made while a reading is pending joins that reading, so
   * readings never overlap.
   * @throws The host or validation failure of the reading; the published
   * period is left unchanged.
   */
  updateLysPersonalityPeriod: () => Promise<LysPersonalityPeriod>
}

/**
 * Registers Lys personality state and its refresh with one Zustand owner.
 *
 * @param set - Framework setter for atomic period updates.
 * @param get - Framework reader for the published period.
 * @returns The initially absent period and its refresh action.
 */
export function createLysPersonalitySlice(
  set: StoreApi<LysPersonalitySlice>["setState"],
  get: StoreApi<LysPersonalitySlice>["getState"]
): LysPersonalitySlice {
  /** Reading in progress, joined by every call made before it settles. */
  let pendingUpdate: Promise<LysPersonalityPeriod> | undefined

  /**
   * Reads the period from the host and publishes it when it changed.
   *
   * @returns Resolves to the period read, after publication or after finding
   * it unchanged.
   * @throws The host or validation failure of the reading.
   */
  async function updateLysPersonalityPeriodFromHost(): Promise<LysPersonalityPeriod> {
    const lysPersonalityPeriod = await getLysPersonalityPeriod()
    const publishedPeriod = get().lysPersonalityPeriod
    if (
      publishedPeriod === undefined ||
      !isSameLysPersonalityPeriod(publishedPeriod, lysPersonalityPeriod)
    ) {
      set({ lysPersonalityPeriod })
    }

    return lysPersonalityPeriod
  }

  /**
   * Runs one host reading as the pending update and releases that role when
   * the reading settles.
   *
   * @returns Resolves to the period read.
   * @throws The host or validation failure of the reading, after the pending
   * update is released so the next call starts a new reading.
   */
  async function startPendingLysPersonalityUpdate(): Promise<LysPersonalityPeriod> {
    try {
      return await updateLysPersonalityPeriodFromHost()
    } finally {
      pendingUpdate = undefined
    }
  }

  /** Implements {@link LysPersonalitySlice.updateLysPersonalityPeriod}. */
  function updateLysPersonalityPeriod(): Promise<LysPersonalityPeriod> {
    pendingUpdate ??= startPendingLysPersonalityUpdate()
    return pendingUpdate
  }

  return { lysPersonalityPeriod: undefined, updateLysPersonalityPeriod }
}
