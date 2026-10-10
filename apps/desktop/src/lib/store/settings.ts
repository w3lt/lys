import type { ModelLoadConfiguration } from "@lys/share"

import committedDefaultModelLoadConfiguration from "../../../src-tauri/default_model_load_configuration.json"

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
 * @remarks The stored default has this shape, mirroring Rust's
 * `DefaultModelLoadConfiguration`, and so does the configuration resolved for
 * one model, because the default supplies every setting the model does not
 * have of its own. An absent expert count is left to LM Studio.
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
 * stored values. Edits apply to the next load of the model they belong to and
 * are saved automatically.
 */
export type LoadConfigurationSettings = {
  /** Settings used for a model that has none of its own. */
  readonly default: CompleteModelLoadConfiguration
  /**
   * Settings each model has of its own, keyed by model key. An entry holds
   * only the settings changed for that model; the default supplies the rest.
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
 * Renderer-side fallback settings used before Tauri initialization completes.
 *
 * @remarks Values match the Rust `Default` implementations so the pre-load
 * render shows the same settings the backend would create for a first run.
 * The load configuration default is read from the committed default file that
 * the native host embeds, so the two cannot differ.
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
  loadConfiguration: {
    default: committedDefaultModelLoadConfiguration,
    models: {}
  }
}
