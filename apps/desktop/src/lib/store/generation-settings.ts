import type { StoreApi } from "zustand"

import { saveGenerationSettings as persistGenerationSettings } from "@/lib/apis/tauri/settings"
import type { GenerationSettings, LysSettings } from "./settings"

/** Application-owned generation-save lifecycle; edits remain usable after failure. */
export type GenerationSaveState =
  | { readonly status: "idle" }
  | { readonly status: "saving" }
  | { readonly status: "saved" }
  | { readonly status: "failed" }

/** Generation autosave state and its retry command. */
export type GenerationSettingsSlice = {
  /** Latest save outcome, retained across settings-pane unmounts. */
  readonly generationSave: GenerationSaveState
  /**
   * Persists current generation settings, preserving other groups on disk.
   * @returns Resolves after the latest edit is saved or fails. Calls during a
   * save return immediately; the active owner also saves any newer edits.
   */
  readonly saveGenerationSettings: () => Promise<void>
}

/** Narrow application state borrowed by the generation persistence slice. */
type GenerationSettingsStore = GenerationSettingsSlice & {
  /** Current settings owned by the application store. */
  readonly settings: LysSettings
}

/**
 * Compares generation controls by value without depending on object identity.
 * @param first - One accepted generation settings value.
 * @param second - The other accepted generation settings value.
 * @returns Whether both settings produce the same generation controls.
 */
export function isGenerationSettingsEqual(
  first: GenerationSettings,
  second: GenerationSettings
): boolean {
  return (
    first.temperature === second.temperature &&
    first.replyCeiling === second.replyCeiling
  )
}

/**
 * Creates the application-owned generation autosave command and initial state.
 * @param set - Owning store's atomic state updater.
 * @param get - Reads the current settings and save lifecycle.
 * @returns A slice that serializes writes and coalesces pending edits to the latest value.
 * @remarks Native writes are not cancellable. Pane unmount does not cancel work;
 * completion never overwrites edits made after the save began. A newer edit is
 * saved after the active write settles, including after failure. Otherwise a
 * failure stops saving until another edit or explicit retry; generationSave
 * exposes that failure without native paths or raw error payloads.
 */
export function createGenerationSettingsSlice(
  set: StoreApi<GenerationSettingsStore>["setState"],
  get: StoreApi<GenerationSettingsStore>["getState"]
): GenerationSettingsSlice {
  /**
   * Saves successive current snapshots until the latest edit is persisted or fails.
   * @returns Resolves after settlement; an active save owns overlapping edit requests.
   */
  async function saveGenerationSettings(): Promise<void> {
    if (get().generationSave.status === "saving") return
    set({ generationSave: { status: "saving" } })
    while (true) {
      const generation = { ...get().settings.generation }
      try {
        await persistGenerationSettings(generation)
      } catch {
        if (!isGenerationSettingsEqual(generation, get().settings.generation)) {
          continue
        }
        set({ generationSave: { status: "failed" } })
        return
      }
      if (isGenerationSettingsEqual(generation, get().settings.generation)) {
        set({ generationSave: { status: "saved" } })
        return
      }
    }
  }

  return { generationSave: { status: "idle" }, saveGenerationSettings }
}
