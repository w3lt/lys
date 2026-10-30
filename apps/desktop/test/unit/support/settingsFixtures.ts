import {
  groqApiKeySchema,
  llmProviderSettingsSchema,
  locationSettingsSchema,
  modelLoadConfigurationSchema,
  tavilyApiKeySchema,
  type ModelLoadConfiguration
} from "@lys/share"
import type {
  GenerationSettings,
  LocationSettings,
  LysSettings,
  ProvidersSettings,
  RuntimeSettings,
  SecretsSettings,
  ToolSettings
} from "@/lib/store/settings"

/**
 * Settings document as the Tauri settings commands exchange it: the JSON form
 * of Rust's `LysSettings`.
 *
 * @remarks The runtime, generation, secrets, providers, and location groups
 * are the renderer's groups field for field; the saved keys, addresses, and
 * place names are plain text in JSON and branded only in the renderer. JSON has no map or set, so the per-model load
 * settings are one object whose keys are model keys, where the renderer holds
 * a map, and the tools on Just run are an array, where the renderer holds a
 * set.
 */
export type SettingsDocument = Readonly<
  Omit<LysSettings, "loadConfiguration" | "tools"> & {
    /** Default and per-model load settings, the latter as one object. */
    loadConfiguration: Readonly<{
      /** Settings for every model that has none of its own. */
      default: ModelLoadConfiguration
      /** Settings each model has of its own, keyed by model key. */
      models: Readonly<Record<string, ModelLoadConfiguration>>
    }>
    /**
     * Tool choices, the tools on Just run as an array and the switches as an
     * object keyed by tool name.
     */
    tools: Readonly<{
      /** Names of the tools on Just run, as the document lists them. */
      justRun: readonly string[]
      /** Whether each tool the person switched is on, keyed by tool name. */
      switches: Readonly<Record<string, boolean>>
    }>
  }
>

/**
 * Load configuration a model whose maximum context is 8,192 tokens is loaded
 * with while no load setting is stored: the committed default's values,
 * written out so that a load-body expectation does not reuse the code under
 * test.
 */
export const FIRST_RUN_LOAD_CONFIGURATION = Object.freeze({
  contextLength: 8192,
  evalBatchSize: 512,
  flashAttention: true,
  offloadKVCacheToGpu: true
})

/** Runtime group on disk, distinct from every default. */
const STORED_RUNTIME_SETTINGS: RuntimeSettings = Object.freeze({
  autoStartBackend: false,
  autoStartVmo: false,
  defaultModel: "qwen3-8b",
  backendAddress: "http://127.0.0.1:23456"
})

/** Generation group on disk, distinct from the default. */
const STORED_GENERATION_SETTINGS: GenerationSettings = Object.freeze({
  temperature: 0.2,
  replyCeiling: 512
})

/**
 * Stored default load settings a person wrote into the settings file by hand;
 * a first-run file has none.
 */
const STORED_DEFAULT_LOAD_CONFIGURATION = modelLoadConfigurationSchema.parse({
  contextLength: 16_384
})

/** Load settings `qwen3-8b` has of its own on disk. */
const STORED_MODEL_LOAD_CONFIGURATION = modelLoadConfigurationSchema.parse({
  evalBatchSize: 256,
  flashAttention: false
})

/**
 * Tavily API key saved on disk: a made-up value of a key's shape, never a key
 * Tavily issued.
 */
export const STORED_TAVILY_API_KEY = tavilyApiKeySchema.parse(
  "tvly-dev-fixture-0000000000000000"
)

/**
 * Groq API key saved on disk: a made-up value of a key's shape, never a key
 * Groq issued.
 */
export const STORED_GROQ_API_KEY = groqApiKeySchema.parse(
  "gsk_fixture_0000000000000000"
)

/**
 * Secrets group on disk, distinct from the first-run group, which has no key:
 * a Tavily key and a Groq key, and no Ollama key.
 */
const STORED_SECRETS_SETTINGS: SecretsSettings = Object.freeze({
  tavilyApiKey: STORED_TAVILY_API_KEY,
  ollamaApiKey: null,
  groqApiKey: STORED_GROQ_API_KEY
})

/**
 * Providers group on disk, distinct from the first-run group: local Ollama is
 * active at a saved address, and LM Studio keeps its default.
 */
export const STORED_PROVIDERS_SETTINGS: ProvidersSettings =
  llmProviderSettingsSchema.parse({
    active: "ollama",
    lmStudio: { address: null },
    ollama: { address: "192.168.1.20:11434" }
  })

/**
 * Tools group on disk: `read_page` is on Just run and `search_files` is
 * switched off.
 */
const STORED_TOOL_SETTINGS: ToolSettings = Object.freeze({
  justRunToolNames: new Set(["read_page"]),
  switches: new Map([["search_files", false]])
})

/**
 * Location group on disk: a city and a country, with no region, distinct from
 * the first-run group, which saves no location.
 */
export const STORED_LOCATION_SETTINGS: LocationSettings =
  locationSettingsSchema.parse({
    city: "Lyon",
    region: null,
    country: "France"
  })

/**
 * Settings document `load_settings` resolves with: every group is set, one
 * model has load settings of its own, a Tavily and a Groq API key are saved,
 * local Ollama is the active provider at a saved address, one tool is on Just
 * run, one tool is switched off, and a location is saved.
 */
export const STORED_SETTINGS_DOCUMENT: SettingsDocument = Object.freeze({
  runtime: STORED_RUNTIME_SETTINGS,
  generation: STORED_GENERATION_SETTINGS,
  loadConfiguration: Object.freeze({
    default: STORED_DEFAULT_LOAD_CONFIGURATION,
    models: Object.freeze({ "qwen3-8b": STORED_MODEL_LOAD_CONFIGURATION })
  }),
  secrets: STORED_SECRETS_SETTINGS,
  providers: STORED_PROVIDERS_SETTINGS,
  tools: Object.freeze({
    justRun: Object.freeze(["read_page"]),
    switches: Object.freeze({ search_files: false })
  }),
  location: STORED_LOCATION_SETTINGS
})

/**
 * The renderer's settings for {@link STORED_SETTINGS_DOCUMENT}: the same
 * groups, with the per-model load settings as a map keyed by model key, the
 * tools on Just run as a set, and the tool switches as a map keyed by tool
 * name.
 *
 * @remarks The maps and the set are read-only through their types; no
 * consumer of the settings mutates them, so the value is safe to share
 * between cases.
 */
export const STORED_SETTINGS: LysSettings = Object.freeze({
  runtime: STORED_RUNTIME_SETTINGS,
  generation: STORED_GENERATION_SETTINGS,
  loadConfiguration: Object.freeze({
    default: STORED_DEFAULT_LOAD_CONFIGURATION,
    models: new Map([["qwen3-8b", STORED_MODEL_LOAD_CONFIGURATION]])
  }),
  secrets: STORED_SECRETS_SETTINGS,
  providers: STORED_PROVIDERS_SETTINGS,
  tools: STORED_TOOL_SETTINGS,
  location: STORED_LOCATION_SETTINGS
})
