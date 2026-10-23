import {
  locationSettingsSchema,
  tavilyApiKeySchema,
  type ModelLoadConfiguration
} from "@lys/share"

import type {
  GenerationSettings,
  LoadConfigurationSettings,
  LocationSettings,
  LysSettings,
  RuntimeAutoStartSettings,
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
 * @remarks Matches Rust's `ToolSettings`. JSON has no set or map, so the
 * Just run names are one array, which Rust stores in ascending order with
 * each name once, and the switches one object keyed by tool name, which Rust
 * stores in ascending name order. Both stay inside this adapter; the rest of
 * the renderer reads the set and the map of {@link ToolSettings}.
 */
type SettingsDocumentTools = {
  /** Names of the tools on Just run. */
  readonly justRun: readonly string[]
  /** Whether each tool the person switched is on, keyed by tool name. */
  readonly switches: Readonly<Record<string, boolean>>
}

/**
 * The `location` group as the settings document holds it.
 *
 * @remarks Matches Rust's `LocationSettings`; the names are plain text here
 * and branded only after {@link buildLocationSettings} parses them.
 */
type SettingsDocumentLocation = {
  /** Saved city, or null. */
  readonly city: string | null
  /** Saved region, or null. */
  readonly region: string | null
  /** Saved country, or null. */
  readonly country: string | null
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
  /** Sampling settings applied to the next request. */
  readonly generation: GenerationSettings
  /** Default and per-model load settings, the latter as one object. */
  readonly loadConfiguration: SettingsDocumentLoadConfiguration
  /** Secrets, with the key as plain text. */
  readonly secrets: SettingsDocumentSecrets
  /** Tool choices, with the names on Just run as one array. */
  readonly tools: SettingsDocumentTools
  /** Saved location, with the names as plain text. */
  readonly location: SettingsDocumentLocation
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
 * Builds the renderer's location from the document group.
 *
 * @param location - Group Rust validated.
 * @returns The location with its names branded.
 * @throws If the group fails the shared location schema, which Rust's
 * validation rules out; the error never contains the location.
 */
function buildLocationSettings(
  location: SettingsDocumentLocation
): LocationSettings {
  const parsed = locationSettingsSchema.safeParse(location)
  if (!parsed.success) {
    throw new Error("The settings file holds an invalid location.")
  }
  return parsed.data
}

/**
 * Builds the document group that stores the renderer's tool choices.
 *
 * @param tools - Tool choices owned by the desktop store.
 * @returns A newly owned group listing the Just run names in the set's
 * order, and the switches as an object with one property of its own per map
 * entry, also for a tool name that names a member of the object prototype;
 * Rust stores both in ascending name order.
 */
function buildSettingsDocumentTools(
  tools: ToolSettings
): SettingsDocumentTools {
  return {
    justRun: [...tools.justRunToolNames],
    switches: Object.fromEntries(tools.switches)
  }
}

/**
 * Builds the renderer's tool choices from the document group.
 *
 * @param tools - Group Rust validated.
 * @returns Newly owned choices: the Just run names as a set, and the
 * switches as a map with one entry per property of the document's object,
 * whatever the text of the name.
 */
function buildToolSettings(tools: SettingsDocumentTools): ToolSettings {
  return {
    justRunToolNames: new Set(tools.justRun),
    switches: new Map(Object.entries(tools.switches))
  }
}

/**
 * Builds the renderer's settings from a settings document.
 *
 * @param settingsDocument - Document a Tauri settings command resolved with,
 * already validated by Rust.
 * @returns Settings holding the document's groups. The per-model load
 * settings are a newly owned map with one entry per key of the document's
 * object, whatever the text of the key, and the tool choices are newly
 * owned, as {@link buildToolSettings} builds them.
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
    generation: settingsDocument.generation,
    loadConfiguration,
    secrets: buildSecretsSettings(settingsDocument.secrets),
    tools: buildToolSettings(settingsDocument.tools),
    location: buildLocationSettings(settingsDocument.location)
  }
}

/**
 * Builds the settings document that stores the renderer's settings.
 *
 * @param settings - Complete settings value owned by the desktop store.
 * @returns A document holding the same groups. The per-model load settings
 * are a newly owned object with one property of its own per map entry, also
 * for a model key that names a member of the object prototype, and the tool
 * choices are an array and an object, as
 * {@link buildSettingsDocumentTools} builds them.
 */
function buildSettingsDocument(settings: LysSettings): SettingsDocument {
  const models = Object.fromEntries(settings.loadConfiguration.models)
  const loadConfiguration: SettingsDocumentLoadConfiguration = {
    default: settings.loadConfiguration.default,
    models
  }
  return {
    runtime: settings.runtime,
    generation: settings.generation,
    loadConfiguration,
    secrets: { tavilyApiKey: settings.secrets.tavilyApiKey },
    tools: buildSettingsDocumentTools(settings.tools),
    location: settings.location
  }
}

/**
 * Loads desktop settings from the Tauri-persisted settings file.
 *
 * @returns The settings of the complete document after Rust validation and
 * defaulting, with the per-model load settings as a map keyed by model key,
 * the tools on Just run as a set, and the tool switches as a map keyed by
 * tool name.
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
 * model key, the tools on Just run as one array, and the tool switches as
 * one object keyed by tool name, the forms the settings file keeps.
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
 * @param tools - Tool choices to save; every name in the set and every
 * switch in the map is written, also for a tool Lys does not list now.
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

/**
 * Persists the location while preserving everything else already on disk.
 * @param location - Location to save; null parts are written as null, and a
 * location whose parts are all null removes the saved one.
 * @returns Resolves after the merged settings document is written by Tauri,
 * which replaces the file atomically and owner-only.
 * @throws The native load or save rejection; no replacement is written if
 * loading fails.
 * @remarks The application store serializes this read-modify-write operation
 * with the other settings-group saves, so that overlapping saves cannot write
 * back each other's stale group.
 */
export async function saveLocationSettings(
  location: LocationSettings
): Promise<void> {
  const persistedSettings = await loadSettings()
  await saveSettings({ ...persistedSettings, location })
}

/**
 * Persists the two startup switches while preserving everything else already
 * on disk.
 * @param autoStart - Startup switches sampled by the application autosave
 * owner.
 * @returns Resolves after the merged settings document is written by Tauri.
 * @throws The native load or save rejection; no replacement is written if
 * loading fails.
 * @remarks The runtime group is written with the given switches and the
 * default model and backend address as they are on disk: the store's copies
 * of those two are session-only. The application store serializes this
 * read-modify-write operation with the other settings-group saves, so that
 * overlapping saves cannot write back each other's stale group.
 */
export async function saveRuntimeAutoStartSettings(
  autoStart: RuntimeAutoStartSettings
): Promise<void> {
  const persistedSettings = await loadSettings()
  const runtime: RuntimeSettings = {
    autoStartBackend: autoStart.autoStartBackend,
    autoStartVmo: autoStart.autoStartVmo,
    defaultModel: persistedSettings.runtime.defaultModel,
    backendAddress: persistedSettings.runtime.backendAddress
  }
  await saveSettings({ ...persistedSettings, runtime })
}
