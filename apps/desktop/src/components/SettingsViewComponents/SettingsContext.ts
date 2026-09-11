import { createContext, use } from "react"

import type { ModelState } from "@/lib/store/model-runtime"
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
 * change callbacks are synchronous proposals against in-memory state. Accepted
 * generation edits also start application-owned autosave; generationSave reports
 * its eventual outcome. Consumers must render below the provider and must not
 * retain or mutate the settings object.
 *
 * The model callbacks describe weight-lifecycle intent. `onLoadModel` and
 * `onUnloadModel` await backend acknowledgement and inventory reconciliation.
 * `onTestModel` observes loaded state without inference. The application store
 * owns request completion and exposes errors and health results to the panes.
 */
export type SettingsContextValue = ModelState & {
  /** Complete settings value currently shown by the panes. */
  readonly settings: LysSettings
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
   * @returns Resolves after settlement or cancellation; failures remain in modelError.
   */
  onLoadModel: (modelKey: string) => Promise<void>
  /**
   * Requests that the named weights be released from memory.
   *
   * @param modelKey - Model identifier to unload.
   * @returns Resolves after settlement or cancellation; failures remain in modelError.
   */
  onUnloadModel: (modelKey: string) => Promise<void>
  /**
   * Observes whether the named weights are currently loaded.
   *
   * @param modelKey - Canonical model identifier to query.
   * @returns Resolves after publishing the health observation or handled failure.
   */
  onTestModel: (modelKey: string) => Promise<void>
  /** Refreshes inventory; failures are exposed through modelError. */
  onRefreshModels: () => Promise<void>
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
