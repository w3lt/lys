import type {
  GroqApiKey,
  LlmProviderSettings,
  McpSettings,
  ModelLoadConfiguration,
  OllamaApiKey,
  PlaceName,
  TavilyApiKey
} from "@lys/share"

/**
 * Runtime process settings persisted under the `runtime` JSON object.
 *
 * @remarks Mirrors Rust's `RunTimeSettings`. Field names match the camelCase
 * wire representation, so a loaded value round-trips without mapping. The
 * two startup switches are saved when the Runtime pane changes them and are
 * read when Lys opens. Edits of `defaultModel` and `backendAddress` remain
 * session-only.
 */
export type RuntimeSettings = {
  /** Whether desktop initialization requests backend startup. */
  autoStartBackend: boolean
  /** Whether desktop initialization starts vmo, Lys's page reader. */
  autoStartVmo: boolean
  /**
   * Preferred chat model, or `null` when absent.
   *
   * @remarks Selection does not load weights. The loaded-model preference and
   * fallback are documented in [ModelRuntimeState](./model-runtime.ts).
   */
  defaultModel: string | null
  /** Backend origin shown in runtime settings; HTTP consumers use shared protocol constants. */
  backendAddress: string
}

/**
 * The two startup switches of the runtime group: the part of it the desktop
 * saves.
 */
export type RuntimeAutoStartSettings = Readonly<
  Pick<RuntimeSettings, "autoStartBackend" | "autoStartVmo">
>

/**
 * Generation settings persisted under the `generation` JSON object.
 *
 * @remarks Mirrors Rust's `GenerationSettings`. Rust rejects a temperature
 * outside `[0, 1]` during deserialization, matching the chat API's range.
 * Desktop edits apply to future requests immediately and survive restart after
 * the application-owned automatic save completes.
 */
export type GenerationSettings = {
  /** Sampling temperature; Rust and the chat API accept `[0, 1]`. */
  temperature: number
  /** Maximum completion tokens; zero means omit the request limit. Stored as u32. */
  replyCeiling: number
}

/**
 * A load configuration whose context length, eval batch size, flash attention,
 * and KV cache settings are all set; only the expert count may be absent.
 *
 * @remarks The committed default has this shape, and so does the
 * configuration resolved for one load, because the committed default supplies
 * every setting that neither the model's own settings nor the stored default
 * set. An absent expert count is left to LM Studio.
 */
export type CompleteModelLoadConfiguration = Required<
  Pick<
    ModelLoadConfiguration,
    "contextLength" | "evalBatchSize" | "flashAttention" | "offloadKVCacheToGpu"
  >
> &
  Pick<ModelLoadConfiguration, "numExperts">

/**
 * Load settings persisted under the `loadConfiguration` JSON object.
 *
 * @remarks Holds what Rust's `LoadConfigurationSettings` holds; Rust validates
 * the stored values and reads a missing group or part as empty. The settings
 * file keeps the per-model settings as one object, which the Tauri settings
 * adapter converts to and from the map held here. Both parts hold only
 * settings written to the settings file; the committed default is never
 * copied into them. Edits apply to the next load of the model they belong to
 * and are saved automatically.
 */
export type LoadConfigurationSettings = {
  /**
   * Settings for every model, each one used when the model has none of its
   * own. Empty unless a person writes settings into the settings file; the
   * Model pane does not edit it, and the committed default supplies every
   * setting it leaves out.
   */
  readonly default: ModelLoadConfiguration
  /**
   * Settings each model has of its own, keyed by model key. An entry holds
   * only the settings changed for that model; the stored default, then the
   * committed default, supply the rest. A model with no settings of its own
   * has no entry, so a read by its key gives undefined.
   */
  readonly models: ReadonlyMap<string, ModelLoadConfiguration>
}

/**
 * Secrets persisted under the `secrets` JSON object.
 *
 * @remarks Mirrors Rust's `SecretsSettings`. Rust validates each key on
 * load, and the Tauri settings adapter parses it again with the shared key
 * schema of its service, which brands it. Each key is saved only by an
 * explicit Save: the Tavily key in the Secrets pane, the Ollama and Groq keys
 * in the Providers pane. The backend reads them from the settings file: the
 * Tavily key for each turn that offers `web_search`, a provider's key at
 * each connection attempt while that provider is active. The renderer never
 * logs or sends them.
 */
export type SecretsSettings = {
  /** Saved Tavily API key, or null when none is saved; a secret. */
  readonly tavilyApiKey: TavilyApiKey | null
  /** Saved key of Ollama Cloud, or null when none is saved; a secret. */
  readonly ollamaApiKey: OllamaApiKey | null
  /** Saved Groq API key, or null when none is saved; a secret. */
  readonly groqApiKey: GroqApiKey | null
}

/**
 * Provider choice and server addresses persisted under the `providers` JSON
 * object.
 *
 * @remarks Mirrors Rust's `ProvidersSettings`; the Tauri settings adapter
 * parses the group with the shared provider settings schema, which brands the
 * addresses. A null address means the provider's default address. The group
 * is saved when the Providers pane picks a provider, a mode, or an address;
 * the backend reads it at each connection attempt.
 */
export type ProvidersSettings = LlmProviderSettings

/**
 * Tool choices persisted under the `tools` JSON object.
 *
 * @remarks Holds what Rust's `ToolSettings` holds; Rust validates each name
 * against the shared tool name rule and reads a missing group, list, or
 * object as empty. The settings file keeps the Just run names as one array
 * and the switches as one object keyed by tool name, both in ascending name
 * order, which the Tauri settings adapter converts to and from the set and
 * the map held here. A tool not in the set asks the person before each call.
 * A tool without a switch is on or off as its access makes it by default, so
 * a tool added later starts at its own default. A name Lys does not list is
 * kept and has no effect. The application store saves the group
 * automatically whenever a tool's approval or switch changes.
 */
export type ToolSettings = {
  /** Names of the tools that run at once, without asking, when called. */
  readonly justRunToolNames: ReadonlySet<string>
  /**
   * Whether each tool the person switched is on, keyed by tool name; only
   * tools the person switched have an entry.
   */
  readonly switches: ReadonlyMap<string, boolean>
}

/**
 * Location persisted under the `location` JSON object: the place the person
 * typed, never one Lys detected.
 *
 * @remarks Mirrors Rust's `LocationSettings`. Rust validates each name on
 * load, and the Tauri settings adapter parses the group again with the
 * shared location schema, which brands the names. A group whose parts are
 * all null saves no location. The group is saved only by an explicit Save in
 * the Tools pane; the `get_location` tool reads it from the settings file
 * when a model calls it. The location is personal data: the renderer never
 * logs it or sends it anywhere but to the Tauri settings commands.
 */
export type LocationSettings = {
  /** City, town, or other locality, or null when not saved. */
  readonly city: PlaceName | null
  /** State, province, or other region, or null when not saved. */
  readonly region: PlaceName | null
  /** Country, or null when not saved. */
  readonly country: PlaceName | null
}

/**
 * Renderer projection of the complete Tauri-persisted settings document.
 *
 * @remarks Holds the seven groups of Rust's `LysSettings` under the same
 * names, so a saved value cannot silently drop a persisted group. The
 * runtime and generation groups match Rust field for field. The load
 * configuration group differs only in its per-model settings, a map here and
 * one object in the document, and the tools group in its Just run names, a
 * set here and one array in the document, and its switches, a map here and
 * one object in the document; the Tauri settings adapter converts between
 * the two.
 */
export type LysSettings = {
  /** Backend process and default-model settings. */
  runtime: RuntimeSettings
  /** Sampling settings applied to the next request. */
  generation: GenerationSettings
  /** Default and per-model settings sent with each model load. */
  loadConfiguration: LoadConfigurationSettings
  /** Keys of the services Lys calls on the person's behalf. */
  secrets: SecretsSettings
  /** Provider every request goes to, and its server's address. */
  providers: ProvidersSettings
  /** Tools the person set to Just run and tools the person switched. */
  tools: ToolSettings
  /** Location the person saved for the `get_location` tool. */
  location: LocationSettings
  /**
   * MCP servers the backend connects to, as the shared `mcp` group schema
   * validates them.
   *
   * @remarks Rust validates the group on load with the same rules, and the
   * Tauri settings adapter parses it again with the shared schema. The group
   * is saved only by an explicit Save or Remove in the MCP pane; the backend
   * reads it from the settings file when it starts and when the desktop asks
   * it to apply the group again. Environment values and header values can be
   * secrets: the renderer never logs them or sends them anywhere but to the
   * Tauri settings commands.
   */
  mcp: McpSettings
}

/**
 * Stored default of a settings file that sets no load setting, so the
 * committed default supplies every one.
 */
const UNSET_STORED_DEFAULT_LOAD_CONFIGURATION: ModelLoadConfiguration =
  Object.freeze({})

/** Per-model load settings of a settings file in which no model has its own. */
const NO_OWN_MODEL_LOAD_CONFIGURATIONS: LoadConfigurationSettings["models"] =
  new Map()

/**
 * Load settings shown before Tauri initialization completes: none stored, as
 * in a first-run settings file.
 */
const INITIAL_LOAD_CONFIGURATION_SETTINGS: LoadConfigurationSettings =
  Object.freeze({
    default: UNSET_STORED_DEFAULT_LOAD_CONFIGURATION,
    models: NO_OWN_MODEL_LOAD_CONFIGURATIONS
  })

/**
 * Secrets shown before Tauri initialization completes: no key, as in a
 * first-run settings file.
 */
const INITIAL_SECRETS_SETTINGS: SecretsSettings = Object.freeze({
  tavilyApiKey: null,
  ollamaApiKey: null,
  groqApiKey: null
})

/**
 * Providers shown before Tauri initialization completes: LM Studio at its
 * default address, as in a first-run settings file.
 */
const INITIAL_PROVIDERS_SETTINGS: ProvidersSettings = Object.freeze({
  active: "lmStudio",
  lmStudio: Object.freeze({ address: null }),
  ollama: Object.freeze({ address: null })
})

/**
 * Tool choices shown before Tauri initialization completes: no tool on Just
 * run and no tool switched, as in a first-run settings file, so every call
 * asks and every tool is on or off by default.
 */
const INITIAL_TOOL_SETTINGS: ToolSettings = Object.freeze({
  justRunToolNames: new Set<string>(),
  switches: new Map<string, boolean>()
})

/**
 * Location shown before Tauri initialization completes: none saved, as in a
 * first-run settings file.
 */
const INITIAL_LOCATION_SETTINGS: LocationSettings = Object.freeze({
  city: null,
  region: null,
  country: null
})

/**
 * MCP servers shown before Tauri initialization completes: none, as in a
 * first-run settings file.
 */
const INITIAL_MCP_SETTINGS: McpSettings = Object.freeze({
  servers: Object.freeze([])
})

/**
 * Renderer-side fallback settings used before Tauri initialization completes.
 *
 * @remarks Values match the Rust `Default` implementations so the pre-load
 * render shows the same settings the backend would create for a first run.
 */
export const initialSettingsState: LysSettings = {
  runtime: {
    autoStartBackend: true,
    autoStartVmo: true,
    defaultModel: null,
    backendAddress: "http://127.0.0.1:12345"
  },
  generation: {
    temperature: 0.7,
    replyCeiling: 2048
  },
  loadConfiguration: INITIAL_LOAD_CONFIGURATION_SETTINGS,
  secrets: INITIAL_SECRETS_SETTINGS,
  providers: INITIAL_PROVIDERS_SETTINGS,
  tools: INITIAL_TOOL_SETTINGS,
  location: INITIAL_LOCATION_SETTINGS,
  mcp: INITIAL_MCP_SETTINGS
}
