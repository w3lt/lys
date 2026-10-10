import type {
  GenerationSettings,
  LoadConfigurationSettings,
  LysSettings
} from "@/lib/store/settings"
import { invoke } from "@tauri-apps/api/core"

/**
 * Loads desktop settings from the Tauri-persisted settings file.
 *
 * @returns The complete settings document after Rust validation and defaulting.
 * @throws The Tauri invoke rejection when the settings path cannot be read or parsed.
 */
export async function loadSettings() {
  return await invoke<LysSettings>("load_settings")
}

/**
 * Sends desktop settings to the Tauri settings command.
 *
 * @param settings - Complete settings value owned by the desktop store.
 * @returns Resolves after the native settings file write completes.
 * @throws The Tauri invoke rejection for command deserialization, serialization,
 * or file-writing failures.
 * @remarks The named newSettings argument matches Rust's new_settings parameter.
 */
export async function saveSettings(settings: LysSettings): Promise<void> {
  await invoke("save_settings", { newSettings: settings })
}

/**
 * Persists generation controls while preserving other groups already on disk.
 * @param generation - Accepted controls sampled by the application autosave owner.
 * @returns Resolves after the merged settings document is written by Tauri.
 * @throws The native load or save rejection; no replacement is written if loading fails.
 * @remarks The application store serializes this read-modify-write operation
 * with the other settings-group saves, so that overlapping saves cannot write
 * back each other's stale group.
 */
export async function saveGenerationSettings(
  generation: GenerationSettings
): Promise<void> {
  const persistedSettings = await loadSettings()
  await saveSettings({ ...persistedSettings, generation })
}

/**
 * Persists the per-model load settings while preserving everything else
 * already on disk.
 * @param loadConfiguration - Load settings sampled by the application autosave
 * owner. Only its per-model settings are written; its default is not.
 * @returns Resolves after the merged settings document is written by Tauri.
 * @throws The native load or save rejection; no replacement is written if loading fails.
 * @remarks The stored default is kept as it is on disk, like the other groups.
 * Only a hand edit of the settings file changes it, and the store's copy was
 * read at startup, so writing that copy would undo an edit made since. The
 * application store serializes this read-modify-write operation with the
 * other settings-group saves, so that overlapping saves cannot write back
 * each other's stale group.
 */
export async function saveLoadConfigurationSettings(
  loadConfiguration: LoadConfigurationSettings
): Promise<void> {
  const persistedSettings = await loadSettings()
  const savedLoadConfiguration: LoadConfigurationSettings = {
    default: persistedSettings.loadConfiguration.default,
    models: loadConfiguration.models
  }
  await saveSettings({
    ...persistedSettings,
    loadConfiguration: savedLoadConfiguration
  })
}
