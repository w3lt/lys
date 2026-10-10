import type { LlmInfo, LlmTestModelApiResponse } from "@lys/protocol"

import { buildModelLoadConfiguration } from "@/lib/models/model-load-configuration"

import type {
  CompleteModelLoadConfiguration,
  LoadConfigurationSettings
} from "./settings"

/** Inventory observation; failed and unavailable states never imply an empty runtime. */
export type ModelInventoryState =
  | { readonly status: "unavailable" }
  | { readonly status: "failed" }
  | { readonly status: "ready"; readonly models: readonly LlmInfo[] }

/** One application-owned model request; mutations are serialized in the renderer. */
export type ModelRequestState =
  | { readonly status: "idle" }
  | { readonly status: "listing" }
  | {
      readonly status: "loading" | "unloading" | "testing"
      readonly modelKey: string
    }

/**
 * Compact residency summary for the runtime card and composer.
 * @remarks Several models may be loaded. The summary prefers the loaded default,
 * then the first loaded inventory entry. Unknown means observation failed.
 */
export type ModelRuntimeState =
  | { readonly status: "none" }
  | { readonly status: "unknown" }
  | {
      readonly status: "loading" | "loaded" | "unloading"
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

/** Known load configurations of the loaded models, keyed by model key. */
export type LoadedModelConfigurations = Readonly<
  Record<string, LoadedModelConfiguration>
>

/** Observable model state atomically replaced by the application store. */
export type ModelState = {
  /** Latest complete inventory observation. */
  readonly modelInventory: ModelInventoryState
  /** Current renderer request, or idle after settlement. */
  readonly modelRequest: ModelRequestState
  /** Summary derived atomically from inventory, request, and default. */
  readonly modelRuntime: ModelRuntimeState
  /** Latest safe request failure; null when no failure is shown. */
  readonly modelError: string | null
  /** Latest health observation, cleared by the next operation. */
  readonly modelHealth: LlmTestModelApiResponse | null
  /**
   * Load configuration known for each model observed as loaded; a model that
   * is not loaded has no entry.
   */
  readonly loadedModelConfigurations: LoadedModelConfigurations
}

/** Initial model state before a backend inventory observation. */
export const initialModelState: ModelState = Object.freeze({
  modelInventory: Object.freeze({ status: "unavailable" }),
  modelRequest: Object.freeze({ status: "idle" }),
  modelRuntime: Object.freeze({ status: "none" }),
  modelError: null,
  modelHealth: null,
  loadedModelConfigurations: Object.freeze({})
})

/**
 * Projects inventory into the compact residency summary.
 * @param inventory - Latest authoritative inventory observation.
 * @param request - Current renderer operation.
 * @param defaultModel - Preferred model, without claiming it is loaded.
 * @returns The transition, preferred loaded model, confirmed absence, or unknown state.
 */
export function buildModelRuntime(
  inventory: ModelInventoryState,
  request: ModelRequestState,
  defaultModel: string | null
): ModelRuntimeState {
  if (request.status === "loading" || request.status === "unloading") {
    return { status: request.status, modelKey: request.modelKey }
  }
  if (inventory.status === "failed") return { status: "unknown" }
  if (inventory.status === "unavailable") return { status: "none" }
  const loaded =
    inventory.models.find(
      (model) => model.loaded && model.modelKey === defaultModel
    ) ?? inventory.models.find((model) => model.loaded)
  return loaded
    ? { status: "loaded", modelKey: loaded.modelKey }
    : { status: "none" }
}

/**
 * Reports whether weights are in transition.
 * @param modelRuntime - Current residency summary.
 * @returns True while a load or unload awaits backend settlement.
 */
export function isModelTransitionInFlight(
  modelRuntime: ModelRuntimeState
): boolean {
  return (
    modelRuntime.status === "loading" || modelRuntime.status === "unloading"
  )
}

/**
 * Finds what is known about one loaded model's configuration.
 *
 * @param known - Known configurations of the loaded models.
 * @param modelKey - Key of the model.
 * @returns The model's entry, or undefined when it has none. Members of the
 * object prototype are never returned for a key such as `constructor`.
 */
export function findLoadedModelConfiguration(
  known: LoadedModelConfigurations,
  modelKey: string
): LoadedModelConfiguration | undefined {
  return Object.hasOwn(known, modelKey) ? known[modelKey] : undefined
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
  const otherEntries = Object.entries(known).filter(
    ([knownModelKey]) => knownModelKey !== modelKey
  )
  const sentEntry = [modelKey, { origin: "sent", configuration }] as const
  return Object.fromEntries([...otherEntries, sentEntry])
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
  return Object.fromEntries(
    Object.entries(known).filter(
      ([knownModelKey]) => knownModelKey !== modelKey
    )
  )
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
  return Object.fromEntries(
    inventory.models
      .filter((model) => model.loaded)
      .map((model) => [
        model.modelKey,
        findLoadedModelConfiguration(known, model.modelKey) ?? {
          origin: "assumed",
          configuration: buildModelLoadConfiguration(settings, model)
        }
      ])
  )
}
