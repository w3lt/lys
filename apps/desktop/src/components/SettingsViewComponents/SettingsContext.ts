import { createContext, use } from "react"

import type { LlmProvider, ModelLoadConfiguration } from "@lys/share"
import type { LlmTestModelApiResponse } from "@lys/protocol"

import type { ShownModelState } from "@/lib/hooks/conversationModel"
import type { ProviderAvailability } from "@/lib/models/provider-connection"
import type {
  LoadedModelConfigurations,
  ModelInventoryState,
  ModelRequestState
} from "@/lib/store/model-runtime"
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
 * The panes show one provider's models: the default model's provider while
 * it is on, else the first provider that is on, in provider order, else LM
 * Studio. The model fields hold that provider's state, and the model
 * callbacks act on its models. They describe weight-lifecycle intent.
 * `onLoadModel`, `onUnloadModel`, and `onReloadModel` await backend
 * acknowledgement and inventory reconciliation. `onTestModel` observes
 * loaded state without inference. The application store owns request
 * completion and exposes errors and health results to the panes.
 */
export type SettingsContextValue = {
  /** Complete settings value currently shown by the panes. */
  readonly settings: LysSettings
  /** Provider whose models the panes show. */
  readonly shownProvider: LlmProvider
  /** Whether model requests can reach the shown provider, and why not. */
  readonly providerAvailability: ProviderAvailability
  /** The shown provider's latest complete inventory observation. */
  readonly modelInventory: ModelInventoryState
  /** The shown provider's request in flight, or idle. */
  readonly modelRequest: ModelRequestState
  /** The shown provider's latest safe request failure, or null. */
  readonly modelError: string | null
  /** The shown provider's latest health observation, or null. */
  readonly modelHealth: LlmTestModelApiResponse | null
  /** Load configurations known for the shown provider's loaded models. */
  readonly loadedModelConfigurations: LoadedModelConfigurations
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
  /**
   * Requests that the named weights of the shown provider be loaded into
   * memory.
   *
   * @param modelKey - Model identifier to load.
   * @returns Resolves after settlement or cancellation; failures other than a
   * missing LLM runtime remain in modelError.
   */
  onLoadModel: (modelKey: string) => Promise<void>
  /**
   * Requests that the named weights of the shown provider be released from
   * memory.
   *
   * @param modelKey - Model identifier to unload.
   * @returns Resolves after settlement or cancellation; failures other than a
   * missing LLM runtime remain in modelError.
   */
  onUnloadModel: (modelKey: string) => Promise<void>
  /**
   * Requests that the named loaded weights of the shown provider be released
   * and loaded again with their stored load configuration.
   *
   * @param modelKey - Model identifier to reload.
   * @returns Resolves after settlement or cancellation; failures other than a
   * missing LLM runtime remain in modelError. A load that fails after the
   * unload leaves the weights released.
   */
  onReloadModel: (modelKey: string) => Promise<void>
  /**
   * Observes whether the named weights of the shown provider are currently
   * loaded.
   *
   * @param modelKey - Canonical model identifier to query.
   * @returns Resolves after publishing the health observation or handled failure.
   */
  onTestModel: (modelKey: string) => Promise<void>
  /**
   * Refreshes the shown provider's inventory; failures other than a missing
   * LLM runtime are exposed through modelError.
   */
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
