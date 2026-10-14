import { tavilyApiKeySchema, type ModelLoadConfiguration } from "@lys/share"

import type {
  GenerationSettings,
  LoadConfigurationSettings,
  LysSettings,
  ModelSettings,
  RuntimeSettings,
  SecretsSettings,
  ToolSettings
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
 * The `secrets` group as the settings document holds it.
 *
 * @remarks Matches Rust's `SecretsSettings`; the key is plain text here and
 * branded only after {@link buildSecretsSettings} parses it.
 */
type SettingsDocumentSecrets = {
  /** Saved key, or null. */
  readonly tavilyApiKey: string | null
}

/**
 * The `tools` group as the settings document holds it.
 *
 * @remarks Matches Rust's `ToolSettings`. JSON has no set, so the names are
 * one array, which Rust stores in ascending order with each name once. That
 * array stays inside this adapter; the rest of the renderer reads the set of
 * {@link ToolSettings}.
 */
type SettingsDocumentTools = {
  /** Names of the tools on Just run. */
  readonly justRun: readonly string[]
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
  /** Secrets, with the key as plain text. */
  readonly secrets: SettingsDocumentSecrets
  /** Tool choices, with the names on Just run as one array. */
  readonly tools: SettingsDocumentTools
}

/**
 * Builds the renderer's secrets from the document group.
 *
 * @param secrets - Group Rust validated.
 * @returns The secrets with the key branded.
 * @throws If the key fails the shared key schema, which Rust's validation
 * rules out; the error never contains the key.
 */
function buildSecretsSettings(
  secrets: SettingsDocumentSecrets
): SecretsSettings {
  if (secrets.tavilyApiKey === null) return { tavilyApiKey: null }
  const parsed = tavilyApiKeySchema.safeParse(secrets.tavilyApiKey)
  if (!parsed.success) {
    throw new Error("The settings file holds an invalid Tavily API key.")
  }
  return { tavilyApiKey: parsed.data }
}

/**
 * Builds the document group that stores the renderer's tool choices.
 *
 * @param tools - Tool choices owned by the desktop store.
 * @returns A newly owned group listing the names in the set's order; Rust
 * stores them in ascending order.
 */
function buildSettingsDocumentTools(
  tools: ToolSettings
): SettingsDocumentTools {
  return { justRun: [...tools.justRunToolNames] }
}

/**
 * Builds the renderer's settings from a settings document.
 *
 * @param settingsDocument - Document a Tauri settings command resolved with,
 * already validated by Rust.
 * @returns Settings holding the document's groups. The per-model load
 * settings are a newly owned map with one entry per key of the document's
 * object, whatever the text of the key, and the tools on Just run are a
 * newly owned set.
 */
function buildLysSettings(settingsDocument: SettingsDocument): LysSettings {
  const models = new Map(
    Object.entries(settingsDocument.loadConfiguration.models)
  )
  const loadConfiguration: LoadConfigurationSettings = {
    default: settingsDocument.loadConfiguration.default,
    models
  }
  const tools: ToolSettings = {
    justRunToolNames: new Set(settingsDocument.tools.justRun)
  }
  return {
    runtime: settingsDocument.runtime,
    model: settingsDocument.model,
    generation: settingsDocument.generation,
    loadConfiguration,
    secrets: buildSecretsSettings(settingsDocument.secrets),
    tools
  }
}

/**
 * Builds the settings document that stores the renderer's settings.
 *
 * @param settings - Complete settings value owned by the desktop store.
 * @returns A document holding the same groups. The per-model load settings
 * are a newly owned object with one property of its own per map entry, also
 * for a model key that names a member of the object prototype, and the tools
 * on Just run are an array.
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
    loadConfiguration,
    secrets: { tavilyApiKey: settings.secrets.tavilyApiKey },
    tools: buildSettingsDocumentTools(settings.tools)
  }
}

/**
 * Loads desktop settings from the Tauri-persisted settings file.
 *
 * @returns The settings of the complete document after Rust validation and
 * defaulting, with the per-model load settings as a map keyed by model key
 * and the tools on Just run as a set.
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
 * model key, and the tools on Just run as one array, the forms the settings
 * file keeps.
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

/**
 * Persists the secrets while preserving everything else already on disk.
 * @param secrets - Secrets to save; a null key removes the saved one.
 * @returns Resolves after the merged settings document is written by Tauri,
 * which replaces the file atomically and owner-only.
 * @throws The native load or save rejection; no replacement is written if
 * loading fails.
 * @remarks The application store serializes this read-modify-write operation
 * with the other settings-group saves, so that overlapping saves cannot write
 * back each other's stale group.
 */
export async function saveSecretsSettings(
  secrets: SecretsSettings
): Promise<void> {
  const persistedSettings = await loadSettings()
  await saveSettings({ ...persistedSettings, secrets })
}

/**
 * Persists the tool choices while preserving everything else already on disk.
 * @param tools - Tool choices to save; every name in the set is written, also
 * one Lys does not list now.
 * @returns Resolves after the merged settings document is written by Tauri.
 * @throws The native load or save rejection; no replacement is written if
 * loading fails.
 * @remarks The application store serializes this read-modify-write operation
 * with the other settings-group saves, so that overlapping saves cannot write
 * back each other's stale group.
 */
export async function saveToolSettings(tools: ToolSettings): Promise<void> {
  const persistedSettings = await loadSettings()
  await saveSettings({ ...persistedSettings, tools })
}
