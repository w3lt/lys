import type {
  LlmInfo,
  LlmModelLoading,
  LlmRuntimeConnectionStatus,
  LlmTestModelApiResponse
} from "@lys/protocol"
import type { LlmProvider } from "@lys/share"

import { buildModelLoadConfiguration } from "@/lib/models/model-load-configuration"

import type {
  CompleteModelLoadConfiguration,
  LoadConfigurationSettings
} from "./settings"

/** Inventory observation; failed and unavailable states never imply an empty runtime. */
export type ModelInventoryState =
  | { readonly status: "unavailable" }
  | { readonly status: "failed" }
  | {
      readonly status: "ready"
      readonly models: readonly LlmInfo[]
      /**
       * Who loads the models: `lys` when Lys loads and unloads them through
       * the backend, `provider` when the provider decides which models are
       * in memory.
       */
      readonly modelLoading: LlmModelLoading
    }

/**
 * Who loads the models, as the latest inventory reports.
 *
 * @remarks `unknown` while no inventory has been read, so nothing may be
 * offered or explained that depends on who loads the models.
 */
export type ObservedModelLoading = LlmModelLoading | "unknown"

/**
 * Reads who loads the models from the latest inventory observation.
 *
 * @param inventory - Latest inventory observation.
 * @returns What a read inventory reports; `unknown` otherwise.
 */
export function readObservedModelLoading(
  inventory: ModelInventoryState
): ObservedModelLoading {
  return inventory.status === "ready" ? inventory.modelLoading : "unknown"
}

/**
 * One application-owned model request of one provider; the renderer admits
 * one request per provider at a time.
 */
export type ModelRequestState =
  | { readonly status: "idle" }
  | { readonly status: "listing" }
  | {
      readonly status: "loading" | "unloading" | "testing"
      readonly modelKey: string
    }

/**
 * What Lys knows about the load configuration a loaded model runs with.
 *
 * @remarks The runtime does not report the configuration of a loaded model,
 * so this is Lys's own record, kept while the model stays observed as loaded.
 */
export type LoadedModelConfiguration = {
  /**
   * `sent` when Lys loaded the model with this configuration in this session.
   * `assumed` when the model was found already loaded: the configuration is
   * then the one stored when it was first observed, and it only shows whether
   * the stored settings changed since.
   */
  readonly origin: "sent" | "assumed"
  /** Configuration sent with the load, or stored at the first observation. */
  readonly configuration: CompleteModelLoadConfiguration
}

/**
 * Known load configurations of the loaded models, keyed by model key.
 *
 * @remarks Session state that is never serialized. A model that is not
 * observed as loaded has no entry, so a read by its key gives undefined.
 */
export type LoadedModelConfigurations = ReadonlyMap<
  string,
  LoadedModelConfiguration
>

/** Records of a session in which no model has been observed as loaded. */
const NO_LOADED_MODEL_CONFIGURATIONS: LoadedModelConfigurations = new Map()

/**
 * Connection status of one provider as the desktop shows it.
 *
 * @remarks `unknown` means the backend is not running or the provider's
 * status could not be read; the other values mirror the backend's runtime
 * connection to that provider, `off` for a provider that is turned off.
 */
export type LlmProviderStatus = "unknown" | LlmRuntimeConnectionStatus

/**
 * What the desktop knows of one provider: its connection and its models.
 *
 * @remarks The application store replaces it atomically. Only the status
 * survives a release; the rest returns to its initial value whenever the
 * provider is not connected, since nothing can then be observed.
 */
export type ProviderModelState = {
  /** Latest published connection status. */
  readonly status: LlmProviderStatus
  /** Latest complete inventory observation. */
  readonly inventory: ModelInventoryState
  /** Current renderer request, or idle after settlement. */
  readonly request: ModelRequestState
  /** Latest safe request failure; null when no failure is shown. */
  readonly error: string | null
  /** Latest health observation, cleared by the next operation. */
  readonly health: LlmTestModelApiResponse | null
  /**
   * When the latest operation settled with its closing inventory read, or
   * null before one has settled since the last release.
   */
  readonly settledAt: Date | null
  /**
   * Load configuration known for each model observed as loaded; a model that
   * is not loaded has no entry. Only LM Studio's models have entries: the
   * stored load settings name LM Studio's models, the only ones Lys loads.
   */
  readonly loadedModelConfigurations: LoadedModelConfigurations
}

/** What the desktop knows of every provider, keyed by provider. */
export type ProviderModelStates = Readonly<
  Record<LlmProvider, ProviderModelState>
>

/**
 * The model state of a provider before any observation, and after a release:
 * nothing listed, requested, failed, observed, or recorded.
 */
export const RELEASED_PROVIDER_MODELS: Omit<ProviderModelState, "status"> =
  Object.freeze({
    inventory: Object.freeze({ status: "unavailable" }),
    request: Object.freeze({ status: "idle" }),
    error: null,
    health: null,
    settledAt: null,
    loadedModelConfigurations: NO_LOADED_MODEL_CONFIGURATIONS
  })

/** State of a provider before the backend reported its status. */
const INITIAL_PROVIDER_MODEL_STATE: ProviderModelState = Object.freeze({
  status: "unknown",
  ...RELEASED_PROVIDER_MODELS
})

/** Every provider's state before the backend reported anything. */
export const INITIAL_PROVIDER_MODEL_STATES: ProviderModelStates = Object.freeze(
  {
    lmStudio: INITIAL_PROVIDER_MODEL_STATE,
    ollama: INITIAL_PROVIDER_MODEL_STATE,
    ollamaCloud: INITIAL_PROVIDER_MODEL_STATE,
    groq: INITIAL_PROVIDER_MODEL_STATE
  }
)

/**
 * Replaces some fields of one provider's state.
 *
 * @param states - Every provider's state; not modified.
 * @param provider - Provider whose state changes.
 * @param change - Fields to replace; the others keep their values.
 * @returns Newly owned, frozen states in which only that provider's entry is
 * new.
 */
export function updateProviderModelState(
  states: ProviderModelStates,
  provider: LlmProvider,
  change: Partial<ProviderModelState>
): ProviderModelStates {
  return Object.freeze({
    ...states,
    [provider]: Object.freeze({ ...states[provider], ...change })
  })
}

/**
 * Adds the configuration a completed load was sent with.
 *
 * @param known - Known configurations of the loaded models; not modified.
 * @param modelKey - Canonical key of the model the load reported as loaded.
 * @param configuration - Configuration sent with that load.
 * @returns Newly owned records in which the model's entry is the sent
 * configuration, replacing any earlier entry.
 */
export function addSentModelConfiguration(
  known: LoadedModelConfigurations,
  modelKey: string,
  configuration: CompleteModelLoadConfiguration
): LoadedModelConfigurations {
  const sentConfiguration: LoadedModelConfiguration = {
    origin: "sent",
    configuration
  }
  const records = new Map(known)
  records.set(modelKey, sentConfiguration)
  return records
}

/**
 * Removes what is known about one model's configuration.
 *
 * @param known - Known configurations of the loaded models; not modified.
 * @param modelKey - Key of the model whose instances were unloaded.
 * @returns Newly owned records without an entry for the model.
 */
export function removeLoadedModelConfiguration(
  known: LoadedModelConfigurations,
  modelKey: string
): LoadedModelConfigurations {
  const records = new Map(known)
  records.delete(modelKey)
  return records
}

/**
 * Builds the known configurations of the loaded models after an inventory
 * observation.
 *
 * @param known - Records held before the observation; not modified.
 * @param inventory - Inventory observation being published.
 * @param settings - Load settings stored at the time of the observation.
 * @returns Records for exactly the models the inventory lists as loaded. A
 * model that already has a record keeps it; a model without one is assumed to
 * run with the configuration stored now. An inventory that is not ready
 * establishes nothing, so the earlier records are returned unchanged.
 */
export function buildLoadedModelConfigurations(
  known: LoadedModelConfigurations,
  inventory: ModelInventoryState,
  settings: LoadConfigurationSettings
): LoadedModelConfigurations {
  if (inventory.status !== "ready") return known
  return new Map(
    inventory.models
      .filter((model) => model.loaded)
      .map((model) => [
        model.modelKey,
        known.get(model.modelKey) ?? {
          origin: "assumed",
          configuration: buildModelLoadConfiguration(settings, model)
        }
      ])
  )
}
