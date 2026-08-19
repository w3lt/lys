/**
 * Incomplete renderer projection of the Tauri-managed runtime settings.
 *
 * @remarks This is not the complete Rust persisted contract: the renderer omits
 * Rust's `runtime.defaultModel`, `runtime.backendAddress`, and `generation`
 * fields, and `selectedModel` is not mapped to Rust's `defaultModel`. Typed
 * `invoke` does not transform or strip extra fields at this boundary.
 */
export type RuntimeSettings = {
  /** Whether desktop initialization requests backend startup. */
  autoStartBackend: boolean
  /** Optional renderer model selection; absence is not mapped to Rust's `defaultModel`. */
  selectedModel?: string
}

/** Renderer-side settings projection grouped by feature area, not a full persisted schema. */
export type LysSettings = {
  /** Runtime projection; Rust also persists backend address and a differently named model field. */
  runtime: RuntimeSettings
}

/** Renderer-side fallback settings before Tauri initialization completes. */
export const initialSettingsState: LysSettings = {
  runtime: {
    autoStartBackend: false,
    selectedModel: undefined
  }
}
