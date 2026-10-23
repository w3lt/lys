import type { StoreApi } from "zustand"

import type { LocationSettings, LysSettings } from "./settings"

/** Lifecycle of the latest location save. */
export type LocationSaveState =
  | { readonly status: "idle" }
  | { readonly status: "saving" }
  | { readonly status: "saved" }
  | {
      readonly status: "failed"
      /** Caller-safe reason, without the location or a native path. */
      readonly error: string
    }

/**
 * Outcome of one save request: `saved` once the file holds the location,
 * `failed` when the save failed, and `busy` when another location save was
 * still running, so nothing was saved.
 */
export type LocationSaveOutcome = "saved" | "failed" | "busy"

/** Location state and its command. */
export type LocationSettingsSlice = {
  /** Latest save outcome, retained across pane unmounts. */
  readonly locationSave: LocationSaveState
  /**
   * Saves a location; one whose parts are all null removes the saved one.
   * @param location - Location whose names passed the shared place name
   * schema.
   * @returns `saved` after the settings file holds the new location and the
   * store does too, `failed` when the save failed, or `busy` without saving
   * while another location save runs. It never rejects.
   */
  readonly saveLocation: (
    location: LocationSettings
  ) => Promise<LocationSaveOutcome>
}

/** Narrow application state borrowed by the location slice. */
type LocationSettingsStore = LocationSettingsSlice & {
  /** Current settings owned by the application store. */
  readonly settings: LysSettings
}

/** Capabilities the location slice uses. */
export type LocationSettingsDependencies = {
  /** Saves the location group, serialized with the other group saves. */
  readonly saveLocationSettings: (location: LocationSettings) => Promise<void>
}

/** Save state before any save. */
const IDLE_SAVE: LocationSaveState = Object.freeze({ status: "idle" })

/** Save state while a save runs. */
const SAVING: LocationSaveState = Object.freeze({ status: "saving" })

/** Save state after a save. */
const SAVED: LocationSaveState = Object.freeze({ status: "saved" })

/** Save state after a failed save. */
const SAVE_FAILED: LocationSaveState = Object.freeze({
  status: "failed",
  error: "Lys couldn't write your location to its settings file."
})

/**
 * Creates the application-owned location command and initial state.
 * @param set - Owning store's atomic state updater.
 * @param get - Reads the slice's state.
 * @param dependencies - Group save capability.
 * @returns The slice.
 * @remarks The store's location changes only after the file holds the new
 * one, because the `get_location` tool reads the file: the Tools pane never
 * shows a location as saved that a model would not get. Native writes are
 * not cancellable; leaving the pane cancels nothing.
 */
export function createLocationSettingsSlice(
  set: StoreApi<LocationSettingsStore>["setState"],
  get: StoreApi<LocationSettingsStore>["getState"],
  dependencies: LocationSettingsDependencies
): LocationSettingsSlice {
  /**
   * Implements {@link LocationSettingsSlice.saveLocation}.
   * @param location - Location to save.
   * @returns The save outcome.
   */
  async function saveLocation(
    location: LocationSettings
  ): Promise<LocationSaveOutcome> {
    if (get().locationSave.status === "saving") return "busy"
    const savedLocation: LocationSettings = Object.freeze({ ...location })
    set({ locationSave: SAVING })
    try {
      await dependencies.saveLocationSettings(savedLocation)
    } catch {
      set({ locationSave: SAVE_FAILED })
      return "failed"
    }
    set((state) => ({
      settings: { ...state.settings, location: savedLocation },
      locationSave: SAVED
    }))
    return "saved"
  }

  return { locationSave: IDLE_SAVE, saveLocation }
}
