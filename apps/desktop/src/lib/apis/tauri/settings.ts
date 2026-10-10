import type { ModelLoadConfiguration } from "@lys/share"

import type {
  GenerationSettings,
  LoadConfigurationSettings,
  LysSettings,
  ModelSettings,
  RuntimeSettings
} from "@/lib/store/settings"
import { invoke } from "@tauri-apps/api/core"

/**
 * The `loadConfiguration` group as the settings document holds it.
 *
 * @remarks Matches Rust's `LoadConfigurationSettings` field for field. JSON
 * has no map, so the per-model settings are one object whose keys are model
 * keys. That object stays inside this adapter; the rest of the renderer reads
 * the map of {@link LoadConfigurationSettings}.
 */
type SettingsDocumentLoadConfiguration = {
  /** Settings for every model, used where a model has none of its own. */
  readonly default: ModelLoadConfiguration
  /** Settings each model has of its own, as one object keyed by model key. */
  readonly models: Readonly<Record<string, ModelLoadConfiguration>>
}

/**
 * Complete settings document as the Tauri settings commands exchange it.
 *
 * @remarks Matches Rust's `LysSettings` field for field: `load_settings`
 * resolves with it after Rust validation and defaulting, and `save_settings`
 * takes it as the document to write.
 */
type SettingsDocument = {
  /** Backend process and default-model settings. */
  readonly runtime: RuntimeSettings
  /** Local model context estimate. */
  readonly model: ModelSettings
  /** Sampling settings applied to the next request. */
  readonly generation: GenerationSettings
  /** Default and per-model load settings, the latter as one object. */
  readonly loadConfiguration: SettingsDocumentLoadConfiguration
}

/**
 * Builds the renderer's settings from a settings document.
 *
 * @param settingsDocument - Document a Tauri settings command resolved with,
 * already validated by Rust.
 * @returns Settings holding the document's groups. The per-model load
 * settings are a newly owned map with one entry per key of the document's
 * object, whatever the text of the key.
 */
function buildLysSettings(settingsDocument: SettingsDocument): LysSettings {
  const models = new Map(
    Object.entries(settingsDocument.loadConfiguration.models)
  )
  const loadConfiguration: LoadConfigurationSettings = {
    default: settingsDocument.loadConfiguration.default,
    models
  }
  return {
    runtime: settingsDocument.runtime,
    model: settingsDocument.model,
    generation: settingsDocument.generation,
    loadConfiguration
  }
}

/**
 * Builds the settings document that stores the renderer's settings.
 *
 * @param settings - Complete settings value owned by the desktop store.
 * @returns A document holding the same groups. The per-model load settings
 * are a newly owned object with one property of its own per map entry, also
 * for a model key that names a member of the object prototype.
 */
function buildSettingsDocument(settings: LysSettings): SettingsDocument {
  const models = Object.fromEntries(settings.loadConfiguration.models)
  const loadConfiguration: SettingsDocumentLoadConfiguration = {
    default: settings.loadConfiguration.default,
    models
  }
  return {
    runtime: settings.runtime,
    model: settings.model,
    generation: settings.generation,
    loadConfiguration
  }
}

/**
 * Loads desktop settings from the Tauri-persisted settings file.
 *
 * @returns The settings of the complete document after Rust validation and
 * defaulting, with the per-model load settings as a map keyed by model key.
 * @throws The Tauri invoke rejection when the settings path cannot be read or parsed.
 */
export async function loadSettings(): Promise<LysSettings> {
  const settingsDocument = await invoke<SettingsDocument>("load_settings")
  return buildLysSettings(settingsDocument)
}

/**
 * Sends desktop settings to the Tauri settings command.
 *
 * @param settings - Complete settings value owned by the desktop store.
 * @returns Resolves after the native settings file write completes.
 * @throws The Tauri invoke rejection for command deserialization, serialization,
 * or file-writing failures.
 * @remarks The named newSettings argument matches Rust's new_settings
 * parameter. The per-model load settings are sent as one object keyed by
 * model key, the form the settings file keeps.
 */
export async function saveSettings(settings: LysSettings): Promise<void> {
  const newSettings = buildSettingsDocument(settings)
  await invoke("save_settings", { newSettings })
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
