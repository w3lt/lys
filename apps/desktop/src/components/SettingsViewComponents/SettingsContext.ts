import { createContext, use } from "react"

import type { ModelLoadConfiguration } from "@lys/share"
import type { LlmTestModelApiResponse } from "@lys/protocol"

import type { ShownModelState } from "@/lib/hooks/conversationModel"
import type { ModelRequestState } from "@/lib/store/model-runtime"
import type {
  GenerationSettings,
  LysSettings,
  RuntimeSettings
} from "@/lib/store/settings"

/**
 * Settings state and change requests exposed to the settings panes.
 *
 * @remarks The provider owns the settings value and applies every patch. The
 * change callbacks are synchronous proposals against in-memory state. Accepted
 * generation and load configuration edits also start application-owned
 * autosave; generationSave and loadConfigurationSave report its eventual
 * outcome. Consumers must render below the provider and must not retain or
 * mutate the settings object.
 *
 * The model request fields hold one provider's state, which the Runtime
 * pane's request feedback reports: the provider of the model a new
 * conversation uses while it is on, else the first provider that is on, in
 * provider order, else LM Studio. The application store owns every request
 * and its completion; the Runtime and Models panes read every provider's
 * models, and start loads and unloads, through the store itself.
 */
export type SettingsContextValue = {
  /** Complete settings value currently shown by the panes. */
  readonly settings: LysSettings
  /** The shown provider's request in flight, or idle. */
  readonly modelRequest: ModelRequestState
  /** The shown provider's latest safe request failure, or null. */
  readonly modelError: string | null
  /** The shown provider's latest health observation, or null. */
  readonly modelHealth: LlmTestModelApiResponse | null
  /**
   * The model a new conversation uses, with whether it can answer: the
   * default model, or without one the first model that can answer.
   */
  readonly newConversationModel: ShownModelState
  /**
   * Proposes a runtime settings patch to the provider.
   *
   * @param patch - Runtime fields to change; omitted fields are unaffected.
   */
  onRuntimeChange: (patch: Partial<RuntimeSettings>) => void
  /**
   * Proposes a generation settings patch to the provider.
   *
   * @param patch - Generation fields to change; omitted fields are unaffected.
   */
  onGenerationChange: (patch: Partial<GenerationSettings>) => void
  /**
   * Requests that load settings be assigned to one model.
   *
   * @param modelKey - Key of the model whose own load settings change.
   * @param settings - Settings to assign; the model's other settings keep
   * their values. The provider applies them in memory at once, and the next
   * load of that model uses the result.
   */
  onAssignModelLoadSettings: (
    modelKey: string,
    settings: ModelLoadConfiguration
  ) => void
  /**
   * Requests that one model's own expert count be removed, so the default's
   * count, or none, applies to it.
   *
   * @param modelKey - Key of the model whose own expert count is removed.
   */
  onRemoveModelExpertCount: (modelKey: string) => void
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
