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
   * @remarks Selection does not load weights. The runtime projection uses this
   * model when resident and otherwise falls back to the first loaded inventory
   * entry.
   */
  defaultModel: string | null
  /** Backend origin shown in runtime settings; HTTP consumers use shared protocol constants. */
  backendAddress: string
}

/**
 * Local model context estimate persisted under the `model` JSON object.
 *
 * @remarks Mirrors Rust's `ModelSettings`. The context budget supports composer
 * estimates and generation controls; LM Studio owns load-time context size.
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
 * Renderer projection of the complete Tauri-persisted settings document.
 *
 * @remarks The three groups match Rust's `LysSettings` field for field, so
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
