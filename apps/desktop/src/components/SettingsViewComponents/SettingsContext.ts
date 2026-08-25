import { createContext, use } from "react"

import type { ModelRuntimeState } from "@/lib/store/model-runtime"
import type {
  GenerationSettings,
  LysSettings,
  ModelSettings,
  RuntimeSettings
} from "@/lib/store/settings"

/**
 * Settings state and change requests exposed to the settings panes.
 *
 * @remarks The provider owns the settings value and applies every patch. The
 * change callbacks are synchronous proposals against in-memory state: they do
 * not promise persistence, and nothing here is written to disk until the Tauri
 * save boundary is wired. Consumers must render below the provider and must not
 * retain or mutate the settings object.
 *
 * The model callbacks describe weight-lifecycle intent. `onLoadModel` and
 * `onUnloadModel` drive the simulated residency the provider owns; no request
 * reaches the backend, so panes must not assume a call changed server state.
 * `onTestModel` has no endpoint behind it at all and is inert.
 */
export interface SettingsContextValue {
  /** Complete settings value currently shown by the panes. */
  readonly settings: LysSettings
  /** Residency of the weights, and which weights the state refers to. */
  readonly modelRuntime: ModelRuntimeState
  /**
   * Proposes a runtime settings patch to the provider.
   *
   * @param patch - Runtime fields to change; omitted fields are unaffected.
   */
  onRuntimeChange: (patch: Partial<RuntimeSettings>) => void
  /**
   * Proposes a model settings patch to the provider.
   *
   * @param patch - Model fields to change; omitted fields are unaffected.
   */
  onModelChange: (patch: Partial<ModelSettings>) => void
  /**
   * Proposes a generation settings patch to the provider.
   *
   * @param patch - Generation fields to change; omitted fields are unaffected.
   */
  onGenerationChange: (patch: Partial<GenerationSettings>) => void
  /**
   * Requests that the named weights be loaded into memory.
   *
   * @param modelKey - Model identifier to load.
   */
  onLoadModel: (modelKey: string) => void
  /**
   * Requests that the named weights be released from memory.
   *
   * @param modelKey - Model identifier to unload.
   */
  onUnloadModel: (modelKey: string) => void
  /**
   * Requests a probe request against the resident weights.
   *
   * @param modelKey - Model identifier to probe.
   */
  onTestModel: (modelKey: string) => void
}

/** Required settings context; `null` marks the absent-provider state. */
export const SettingsContext = createContext<SettingsContextValue | null>(null)

/**
 * Reads the settings context for one settings pane.
 *
 * @returns The provider-owned settings value and change callbacks.
 * @throws If the calling pane is not rendered below `SettingsContext.Provider`.
 */
export function useSettingsContext(): SettingsContextValue {
  const context = use(SettingsContext)

  if (!context) {
    throw new Error(
      "Settings pane components must be rendered within SettingsContext.Provider"
    )
  }

  return context
}
