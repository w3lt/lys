import {
  modelLoadConfigurationSchema,
  type ModelLoadConfiguration
} from "@lys/share"
import type {
  GenerationSettings,
  LysSettings,
  ModelSettings,
  RuntimeSettings
} from "@/lib/store/settings"

/**
 * Settings document as the Tauri settings commands exchange it: the JSON form
 * of Rust's `LysSettings`.
 *
 * @remarks The runtime, model, and generation groups are the renderer's
 * groups field for field. JSON has no map, so the per-model load settings are
 * one object whose keys are model keys, where the renderer holds a map.
 */
export type SettingsDocument = Readonly<
  Omit<LysSettings, "loadConfiguration"> & {
    /** Default and per-model load settings, the latter as one object. */
    loadConfiguration: Readonly<{
      /** Settings for every model that has none of its own. */
      default: ModelLoadConfiguration
      /** Settings each model has of its own, keyed by model key. */
      models: Readonly<Record<string, ModelLoadConfiguration>>
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
  defaultModel: "qwen3-8b",
  backendAddress: "http://127.0.0.1:23456"
})

/** Model group on disk, distinct from the default. */
const STORED_MODEL_SETTINGS: ModelSettings = Object.freeze({
  contextSize: 4096
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
 * Settings document `load_settings` resolves with: every group is set, and
 * one model has load settings of its own.
 */
export const STORED_SETTINGS_DOCUMENT: SettingsDocument = Object.freeze({
  runtime: STORED_RUNTIME_SETTINGS,
  model: STORED_MODEL_SETTINGS,
  generation: STORED_GENERATION_SETTINGS,
  loadConfiguration: Object.freeze({
    default: STORED_DEFAULT_LOAD_CONFIGURATION,
    models: Object.freeze({ "qwen3-8b": STORED_MODEL_LOAD_CONFIGURATION })
  })
})

/**
 * The renderer's settings for {@link STORED_SETTINGS_DOCUMENT}: the same
 * groups, with the per-model load settings as a map keyed by model key.
 *
 * @remarks The map is read-only through its type; no consumer of the settings
 * mutates it, so the value is safe to share between cases.
 */
export const STORED_SETTINGS: LysSettings = Object.freeze({
  runtime: STORED_RUNTIME_SETTINGS,
  model: STORED_MODEL_SETTINGS,
  generation: STORED_GENERATION_SETTINGS,
  loadConfiguration: Object.freeze({
    default: STORED_DEFAULT_LOAD_CONFIGURATION,
    models: new Map([["qwen3-8b", STORED_MODEL_LOAD_CONFIGURATION]])
  })
})
