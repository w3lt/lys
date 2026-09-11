/**
 * Runtime process settings persisted under the `runtime` JSON object.
 *
 * @remarks Mirrors Rust's `RunTimeSettings`. Field names match the camelCase
 * wire representation, so a loaded value round-trips without mapping.
 */
export type RuntimeSettings = {
  /** Whether desktop initialization requests backend startup. */
  autoStartBackend: boolean
  /** Model identifier loaded by default; `null` when no default is chosen. */
  defaultModel: string | null
  /** Backend origin persisted for runtime consumers, including its scheme. */
  backendAddress: string
}

/**
 * Model load settings persisted under the `model` JSON object.
 *
 * @remarks Mirrors Rust's `ModelSettings`. The context window is read when
 * weights are loaded rather than per request, so a change applies at the next
 * load.
 */
export type ModelSettings = {
  /** Context-window size in tokens requested when weights are loaded. */
  contextSize: number
}

/**
 * Generation settings persisted under the `generation` JSON object.
 *
 * @remarks Mirrors Rust's `GenerationSettings`. Rust rejects a temperature
 * outside `[0, 1]` during deserialization, matching the chat API's range.
 */
export type GenerationSettings = {
  /** Sampling temperature; Rust and the chat API accept `[0, 1]`. */
  temperature: number
  /** Maximum completion tokens; zero means omit the request limit. Stored as u32. */
  replyCeiling: number
}

/**
 * Renderer projection of the complete Tauri-persisted settings document.
 *
 * @remarks The three groups match Rust's `LysSettings` field for field, so
 * `load_settings` deserializes into this type without transformation and a
 * saved value cannot silently drop a persisted group.
 */
export type LysSettings = {
  /** Backend process and default-model settings. */
  runtime: RuntimeSettings
  /** Weight-loading settings applied at model load time. */
  model: ModelSettings
  /** Sampling settings applied to the next request. */
  generation: GenerationSettings
}

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
  }
}
