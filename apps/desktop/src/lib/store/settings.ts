import type { ModelLoadConfiguration } from "@lys/share"

/**
 * Runtime process settings persisted under the `runtime` JSON object.
 *
 * @remarks Mirrors Rust's `RunTimeSettings`. Field names match the camelCase
 * wire representation, so a loaded value round-trips without mapping. Runtime
 * edits in the desktop UI remain session-only.
 */
export type RuntimeSettings = {
  /** Whether desktop initialization requests backend startup. */
  autoStartBackend: boolean
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
 * Local model context estimate persisted under the `model` JSON object.
 *
 * @remarks Mirrors Rust's `ModelSettings`. The context budget supports composer
 * estimates and generation controls. It is separate from the context length a
 * model is loaded with, which belongs to the load configuration.
 * Model edits in the desktop UI remain session-only.
 */
export type ModelSettings = {
  /** Context budget in tokens used for local estimates, not sent when loading weights. */
  contextSize: number
}

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
 * @remarks Mirrors Rust's `LoadConfigurationSettings`, which validates the
 * stored values and reads a missing group or part as empty. Both parts hold
 * only settings written to the settings file; the committed default is never
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
   * committed default, supply the rest.
   */
  readonly models: Readonly<Record<string, ModelLoadConfiguration>>
}

/**
 * Renderer projection of the complete Tauri-persisted settings document.
 *
 * @remarks The four groups match Rust's `LysSettings` field for field, so
 * `load_settings` deserializes into this type without transformation and a
 * saved value cannot silently drop a persisted group.
 */
export type LysSettings = {
  /** Backend process and default-model settings. */
  runtime: RuntimeSettings
  /** Local model context estimate. */
  model: ModelSettings
  /** Sampling settings applied to the next request. */
  generation: GenerationSettings
  /** Default and per-model settings sent with each model load. */
  loadConfiguration: LoadConfigurationSettings
}

/**
 * Stored default of a settings file that sets no load setting, so the
 * committed default supplies every one.
 */
const UNSET_STORED_DEFAULT_LOAD_CONFIGURATION: ModelLoadConfiguration =
  Object.freeze({})

/** Per-model load settings of a settings file in which no model has its own. */
const NO_OWN_MODEL_LOAD_CONFIGURATIONS: LoadConfigurationSettings["models"] =
  Object.freeze({})

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
 * Renderer-side fallback settings used before Tauri initialization completes.
 *
 * @remarks Values match the Rust `Default` implementations so the pre-load
 * render shows the same settings the backend would create for a first run.
 */
export const initialSettingsState: LysSettings = {
  runtime: {
    autoStartBackend: true,
    defaultModel: null,
    backendAddress: "http://127.0.0.1:12345"
  },
  model: {
    contextSize: 32_768
  },
  generation: {
    temperature: 0.7,
    replyCeiling: 2048
  },
  loadConfiguration: INITIAL_LOAD_CONFIGURATION_SETTINGS
}
