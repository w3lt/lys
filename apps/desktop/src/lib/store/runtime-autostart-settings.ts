import type { StoreApi } from "zustand"

import type { LysSettings, RuntimeAutoStartSettings } from "./settings"
import {
  saveLatestSettingsGroup,
  type SettingsGroupSaves
} from "./settings-group-saves"

/**
 * Application-owned lifecycle of the latest save of the startup switches; a
 * switch whose save fails keeps its value for the session, while the next
 * launch follows the switches last saved.
 */
export type RuntimeAutoStartSaveState =
  | { readonly status: "idle" }
  | { readonly status: "saving" }
  | { readonly status: "saved" }
  | { readonly status: "failed" }

/** The autosave of the runtime group's two startup switches. */
export type RuntimeAutoStartSettingsSlice = {
  /** Latest save outcome, retained across settings-pane unmounts. */
  readonly runtimeAutoStartSave: RuntimeAutoStartSaveState
  /**
   * Persists the current startup switches, preserving the rest of the
   * settings file.
   * @returns Resolves after the latest switches are saved or fail; it never
   * rejects. Calls during a save return immediately; the active save also
   * saves any newer change.
   */
  readonly saveRuntimeAutoStartSettings: () => Promise<void>
}

/** Narrow application state borrowed by the runtime-autostart slice. */
type RuntimeAutoStartSettingsStore = RuntimeAutoStartSettingsSlice & {
  /** Current settings owned by the application store. */
  readonly settings: LysSettings
}

/**
 * Compares the startup switches of two runtime values.
 *
 * @param first - One value holding both switches, such as a runtime group.
 * @param second - The other value.
 * @returns Whether both switches are equal; every other field is ignored.
 */
export function isRuntimeAutoStartSettingsEqual(
  first: RuntimeAutoStartSettings,
  second: RuntimeAutoStartSettings
): boolean {
  return (
    first.autoStartBackend === second.autoStartBackend &&
    first.autoStartVmo === second.autoStartVmo
  )
}

/**
 * Creates the application-owned autosave of the startup switches and its
 * initial state.
 * @param set - Owning store's atomic state updater.
 * @param get - Reads the current settings and save lifecycle.
 * @param dependencies - Save operation that the application serializes with
 * the other settings-group saves.
 * @returns A slice that saves the switches, coalescing pending changes to
 * the latest value.
 * @remarks The application store starts a save when the Runtime pane changes
 * a switch. Native writes are not cancellable. Pane unmount does not cancel
 * work; completion never overwrites a change made after the save began. A
 * newer change is saved after the active write settles, including after
 * failure. Otherwise a failure stops saving until another change;
 * `runtimeAutoStartSave` exposes that failure without native paths or raw
 * error payloads.
 */
export function createRuntimeAutoStartSettingsSlice(
  set: StoreApi<RuntimeAutoStartSettingsStore>["setState"],
  get: StoreApi<RuntimeAutoStartSettingsStore>["getState"],
  dependencies: Pick<SettingsGroupSaves, "saveRuntimeAutoStartSettings">
): RuntimeAutoStartSettingsSlice {
  /**
   * Gets the startup switches the store holds now.
   * @returns A new frozen value holding only the two switches.
   */
  function getRuntimeAutoStartSettings(): RuntimeAutoStartSettings {
    const { autoStartBackend, autoStartVmo } = get().settings.runtime
    return Object.freeze({ autoStartBackend, autoStartVmo })
  }

  /**
   * Implements {@link RuntimeAutoStartSettingsSlice.saveRuntimeAutoStartSettings}.
   * @returns Resolves after settlement; an active save owns overlapping
   * requests.
   */
  async function saveRuntimeAutoStartSettings(): Promise<void> {
    if (get().runtimeAutoStartSave.status === "saving") return
    const activeSave: RuntimeAutoStartSaveState = { status: "saving" }
    set({ runtimeAutoStartSave: activeSave })
    const status = await saveLatestSettingsGroup({
      getCurrent: getRuntimeAutoStartSettings,
      isEqual: isRuntimeAutoStartSettingsEqual,
      save: dependencies.saveRuntimeAutoStartSettings
    })
    const settledSave: RuntimeAutoStartSaveState = { status }
    set({ runtimeAutoStartSave: settledSave })
  }

  const idleSave: RuntimeAutoStartSaveState = { status: "idle" }
  return {
    runtimeAutoStartSave: idleSave,
    saveRuntimeAutoStartSettings
  }
}
