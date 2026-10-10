import type { StoreApi } from "zustand"

import { isLoadConfigurationSettingsEqual } from "@/lib/models/model-load-configuration"

import type { LysSettings } from "./settings"
import {
  saveLatestSettingsGroup,
  type SettingsGroupSaves
} from "./settings-group-saves"

/** Application-owned load-configuration save lifecycle; edits remain usable after failure. */
export type LoadConfigurationSaveState =
  | { readonly status: "idle" }
  | { readonly status: "saving" }
  | { readonly status: "saved" }
  | { readonly status: "failed" }

/** Load-configuration autosave state and its retry command. */
export type LoadConfigurationSettingsSlice = {
  /** Latest save outcome, retained across settings-pane unmounts. */
  readonly loadConfigurationSave: LoadConfigurationSaveState
  /**
   * Persists current load settings, preserving other groups on disk.
   * @returns Resolves after the latest edit is saved or fails. Calls during a
   * save return immediately; the active owner also saves any newer edits.
   */
  readonly saveLoadConfigurationSettings: () => Promise<void>
}

/** Narrow application state borrowed by the load-configuration persistence slice. */
type LoadConfigurationSettingsStore = LoadConfigurationSettingsSlice & {
  /** Current settings owned by the application store. */
  readonly settings: LysSettings
}

/**
 * Creates the application-owned load-configuration autosave command and
 * initial state.
 * @param set - Owning store's atomic state updater.
 * @param get - Reads the current settings and save lifecycle.
 * @param dependencies - Save operation that the application serializes with
 * the other settings-group saves.
 * @returns A slice that serializes writes and coalesces pending edits to the latest value.
 * @remarks Native writes are not cancellable. Pane unmount does not cancel work;
 * completion never overwrites edits made after the save began. A newer edit is
 * saved after the active write settles, including after failure. Otherwise a
 * failure stops saving until another edit or explicit retry;
 * loadConfigurationSave exposes that failure without native paths or raw error
 * payloads. Unsaved edits still apply to loads started in this session.
 */
export function createLoadConfigurationSettingsSlice(
  set: StoreApi<LoadConfigurationSettingsStore>["setState"],
  get: StoreApi<LoadConfigurationSettingsStore>["getState"],
  dependencies: Pick<SettingsGroupSaves, "saveLoadConfigurationSettings">
): LoadConfigurationSettingsSlice {
  /**
   * Saves successive current snapshots until the latest edit is persisted or fails.
   * @returns Resolves after settlement; an active save owns overlapping edit requests.
   */
  async function saveLoadConfigurationSettings(): Promise<void> {
    if (get().loadConfigurationSave.status === "saving") return
    set({ loadConfigurationSave: { status: "saving" } })
    const status = await saveLatestSettingsGroup({
      getCurrent: () => get().settings.loadConfiguration,
      isEqual: isLoadConfigurationSettingsEqual,
      save: dependencies.saveLoadConfigurationSettings
    })
    set({ loadConfigurationSave: { status } })
  }

  return {
    loadConfigurationSave: { status: "idle" },
    saveLoadConfigurationSettings
  }
}
