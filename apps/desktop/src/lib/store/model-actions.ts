import type { LlmTestModelApiResponse } from "@lys/protocol"
import type { LlmModelReference, LlmProvider } from "@lys/share"
import type { StoreApi } from "zustand"

import {
  getModelHealth,
  isModelRuntimeUnavailableError,
  listModels,
  loadModel,
  unloadModel,
  type ModelApiConnection
} from "@/lib/apis/http/models"
import {
  buildModelLoadConfiguration,
  type ModelLoadTarget
} from "@/lib/models/model-load-configuration"

import {
  addSentModelConfiguration,
  buildLoadedModelConfigurations,
  RELEASED_PROVIDER_MODELS,
  removeLoadedModelConfiguration,
  updateProviderModelState,
  type LoadedModelConfigurations,
  type ModelInventoryState,
  type ModelRequestState,
  type ProviderModelState
} from "./model-runtime"
import type {
  ProviderBackendConnection,
  ProviderModelsState
} from "./provider-status"
import type {
  CompleteModelLoadConfiguration,
  LoadConfigurationSettings
} from "./settings"

/** Store capabilities the model slice reads and notifies. */
export type ModelSliceDependencies = {
  /** Reads the current backend origin and readiness. */
  readonly getBackendConnection: () => ProviderBackendConnection
  /**
   * Re-reads one provider's status after its request failed or reported an
   * unavailable runtime.
   *
   * @param provider - Provider whose request failed.
   * @remarks Resolves after the status settles and never rejects.
   */
  readonly handleModelRequestFailure: (provider: LlmProvider) => Promise<void>
  /**
   * Reads the stored default and per-model load settings, which name LM
   * Studio's models.
   *
   * @remarks Sampled when a load is admitted, so later edits do not change
   * the settings that load sends, and when an inventory observation finds an
   * LM Studio model already loaded.
   */
  readonly getLoadConfigurationSettings: () => LoadConfigurationSettings
}

/**
 * Application model callbacks, each for one provider; request failures are
 * handled in that provider's `error`, except an inventory query that finds
 * the provider's runtime not connected, which its status explains instead.
 */
export type ModelActions = {
  /**
   * Queries one provider's inventory; resolves after settlement or
   * invalidation, retaining failure in state.
   *
   * @param provider - Provider whose models are listed.
   */
  updateModelInventory: (provider: LlmProvider) => Promise<void>
  /**
   * Loads a model with its stored load configuration and reconciles its
   * provider's inventory; backend work can outlive local observation.
   *
   * @param model - Model to load.
   */
  loadModel: (model: LlmModelReference) => Promise<void>
  /**
   * Applies the stored load configuration to a loaded model: unloads every
   * instance of the key, then loads it again, and reconciles inventory.
   *
   * @param model - Model to reload.
   * @remarks The published request is `unloading`, then `loading`. A failed
   * unload starts no load. A load that fails after the unload leaves the
   * model unloaded, with the failure in the provider's `error`.
   */
  updateLoadedModelConfiguration: (model: LlmModelReference) => Promise<void>
  /**
   * Unloads all instances of a model and reconciles its provider's
   * inventory, including after failure.
   *
   * @param model - Model to unload.
   */
  unloadModel: (model: LlmModelReference) => Promise<void>
  /**
   * Queries a model's loaded-state health without performing inference.
   *
   * @param model - Model to check.
   */
  testModel: (model: LlmModelReference) => Promise<void>
  /**
   * Invalidates one provider's model observations and aborts its transport
   * without unloading weights; the provider's status is kept.
   *
   * @param provider - Provider whose model state is released.
   */
  releaseProviderModels: (provider: LlmProvider) => void
}

/** An admitted request, excluding the idle marker. */
type ActiveModelRequest = Exclude<ModelRequestState, { status: "idle" }>

/** Model operation a caller asks the slice to perform. */
type ModelOperation =
  | {
      /** Reads the inventory without changing the runtime. */
      readonly kind: "inventory-read"
      /** Provider whose inventory is read. */
      readonly provider: LlmProvider
    }
  | {
      /** Loads, unloads, reads the health of, or reloads one model. */
      readonly kind: "load" | "unload" | "health-read" | "reload"
      /** Provider of the model the operation addresses. */
      readonly provider: LlmProvider
      /** Key of the model the operation addresses. */
      readonly modelKey: string
    }

/** One backend request of an admitted model operation. */
type ModelOperationStep =
  | {
      /** Sends nothing; the inventory read that follows every operation is the work. */
      readonly kind: "inventory-read"
    }
  | {
      /** Loads one model. */
      readonly kind: "load"
      /** Key of the model to load. */
      readonly modelKey: string
      /** Load configuration sampled when the operation was admitted. */
      readonly configuration: CompleteModelLoadConfiguration
    }
  | {
      /** Unloads every instance of one model, or reads its health. */
      readonly kind: "unload" | "health-read"
      /** Key of the model the step addresses. */
      readonly modelKey: string
    }

/** What the steps of one operation have established so far. */
type ModelOperationProgress = {
  /** Health observation of a health-read step, otherwise null. */
  readonly health: LlmTestModelApiResponse | null
  /** Failure of the step that ended the operation, otherwise null. */
  readonly error: string | null
  /** Known load configurations after the completed steps. */
  readonly loadedModelConfigurations: LoadedModelConfigurations
}

/**
 * Builds the request state published while one step runs.
 * @param step - Step about to be sent.
 * @returns The listing, loading, unloading, or testing request for the step.
 */
function buildModelRequest(step: ModelOperationStep): ActiveModelRequest {
  switch (step.kind) {
    case "inventory-read":
      return { status: "listing" }
    case "load":
      return { status: "loading", modelKey: step.modelKey }
    case "unload":
      return { status: "unloading", modelKey: step.modelKey }
    case "health-read":
      return { status: "testing", modelKey: step.modelKey }
  }
}

/**
 * Sends one step to the backend and records what it established.
 * @param provider - Provider the step is sent to.
 * @param step - Step to send.
 * @param connection - Origin and cancellation owned by the operation.
 * @param progress - What the earlier steps established; not modified.
 * @returns New progress: a completed load records the configuration it was
 * sent with under the canonical key the backend reports, a completed unload
 * removes the model's record, and a health read records its observation.
 * @throws The adapter failure for the step; the progress is then unchanged.
 */
async function sendModelOperationStep(
  provider: LlmProvider,
  step: ModelOperationStep,
  connection: ModelApiConnection,
  progress: ModelOperationProgress
): Promise<ModelOperationProgress> {
  switch (step.kind) {
    case "inventory-read":
      return progress
    case "load": {
      const loaded = await loadModel(
        { provider, modelKey: step.modelKey },
        step.configuration,
        connection
      )
      return {
        ...progress,
        loadedModelConfigurations: addSentModelConfiguration(
          progress.loadedModelConfigurations,
          loaded.modelKey,
          step.configuration
        )
      }
    }
    case "unload":
      await unloadModel({ provider, modelKey: step.modelKey }, connection)
      return {
        ...progress,
        loadedModelConfigurations: removeLoadedModelConfiguration(
          progress.loadedModelConfigurations,
          step.modelKey
        )
      }
    case "health-read":
      return {
        ...progress,
        health: await getModelHealth(
          { provider, modelKey: step.modelKey },
          connection
        )
      }
  }
}

/**
 * Formats a handled request failure for inline presentation.
 * @param failure - Failure retained by the HTTP boundary or runtime.
 * @returns A nonempty message without stacks or serialized response payloads.
 */
function formatModelFailure(failure: unknown): string {
  return failure instanceof Error
    ? failure.message
    : "The model request could not be completed."
}

/** Inventory and safe failure published together when an operation settles. */
type ModelInventoryOutcome = {
  /** Fresh snapshot or explicit observation failure. */
  readonly inventory: ModelInventoryState
  /** Action failure, reconciliation failure, or both; excludes an inventory query that found the provider's runtime not connected. */
  readonly error: string | null
  /** Whether the inventory read found the provider's runtime not connected. */
  readonly isModelRuntimeUnavailable: boolean
}

/**
 * Observes one provider's inventory without publishing partially settled
 * state.
 * @param provider - Provider whose models are listed.
 * @param connection - Cancellation and origin owned by the admitted operation.
 * @param priorError - Failure of the preceding action, if any.
 * @returns A complete observation result; failures remain visible as unknown
 * state, except a runtime that is not connected, which leaves inventory
 * unavailable without a model error because the provider's status explains
 * it.
 */
async function readInventoryOutcome(
  provider: LlmProvider,
  connection: ModelApiConnection,
  priorError: string | null
): Promise<ModelInventoryOutcome> {
  try {
    const { llms: models, modelLoading } = await listModels(
      provider,
      connection
    )
    return {
      inventory: { status: "ready", models, modelLoading },
      error: priorError,
      isModelRuntimeUnavailable: false
    }
  } catch (error) {
    if (isModelRuntimeUnavailableError(error)) {
      return {
        inventory: { status: "unavailable" },
        error: priorError,
        isModelRuntimeUnavailable: true
      }
    }
    const message = formatModelFailure(error)
    return {
      inventory: { status: "failed" },
      error: priorError
        ? `${priorError} Inventory refresh also failed: ${message}`
        : message,
      isModelRuntimeUnavailable: false
    }
  }
}

/**
 * Determines whether a settled request warrants a fresh provider status.
 *
 * @param result - Published inventory observation and failure.
 * @param health - Health observation from a test request, if any.
 * @returns Whether the action or reconciliation failed, or health reported an
 * unavailable runtime.
 */
function hasModelRequestFailed(
  result: ModelInventoryOutcome,
  health: LlmTestModelApiResponse | null
): boolean {
  if (result.error !== null || result.isModelRuntimeUnavailable) {
    return true
  }
  return (
    health?.status === "not-ready" && health.reason === "runtime-unavailable"
  )
}

/**
 * Builds the load configurations known after an operation settles.
 *
 * @param provider - Provider the operation was sent to.
 * @param known - Records the operation's steps established; not modified.
 * @param inventory - Inventory observation being published.
 * @param settings - Load settings stored now.
 * @returns For LM Studio, the records of exactly its loaded models, as
 * {@link buildLoadedModelConfigurations} builds them; for any other provider
 * none, since the stored load settings name LM Studio's models only.
 */
function buildProviderLoadedModelConfigurations(
  provider: LlmProvider,
  known: LoadedModelConfigurations,
  inventory: ModelInventoryState,
  settings: LoadConfigurationSettings
): LoadedModelConfigurations {
  return provider === "lmStudio"
    ? buildLoadedModelConfigurations(known, inventory, settings)
    : RELEASED_PROVIDER_MODELS.loadedModelConfigurations
}

/**
 * Registers model callbacks with one Zustand state owner.
 * @param set - Framework setter for atomic model-state updates.
 * @param get - Framework reader for current model state.
 * @param dependencies - Backend reader, the failure reaction, and the load
 * settings owned by the store.
 * @returns The callbacks; the owning store holds every provider's model
 * state in `providerModels`.
 * @remarks Each provider admits one request at a time, and a request for a
 * provider whose request is in flight is dropped; requests for different
 * providers run at once, so one provider's slow list or load never delays
 * another's. A request is admitted only while the backend runs and its
 * provider is connected, and survives view unmounts. Release invalidates
 * publication before aborting local transport. Accepted backend work can
 * continue after disconnect. Mutations are never retried; their outcomes,
 * including failures, are followed by a fresh inventory query of the same
 * provider. A load sends the model's stored load configuration as sampled at
 * admission, and the slice remembers what it sent to LM Studio for as long
 * as the model stays observed as loaded; release discards those records. A
 * settled request that failed, or whose health reported an unavailable
 * runtime, awaits the store's refresh of that provider's status before
 * resolving.
 */
export function createModelSlice(
  set: StoreApi<ProviderModelsState>["setState"],
  get: StoreApi<ProviderModelsState>["getState"],
  dependencies: ModelSliceDependencies
): ModelActions {
  const activeRequests = new Map<LlmProvider, AbortController>()

  /**
   * Replaces some fields of one provider's model state.
   * @param provider - Provider whose state changes.
   * @param change - Fields to replace.
   */
  function updateProviderModels(
    provider: LlmProvider,
    change: Partial<ProviderModelState>
  ): void {
    set((state) => ({
      providerModels: updateProviderModelState(
        state.providerModels,
        provider,
        change
      )
    }))
  }

  /**
   * Answers whether one provider admits model requests now.
   * @param provider - Provider to check.
   * @returns Whether the backend runs and the provider is connected.
   */
  function isProviderAvailable(provider: LlmProvider): boolean {
    return (
      dependencies.getBackendConnection().isBackendRunning &&
      get().providerModels[provider].status === "connected"
    )
  }

  /**
   * Checks publication authority after an asynchronous boundary.
   * @param provider - Provider the request is for.
   * @param controller - Request identity being checked.
   * @param backendUrl - Origin sampled at admission.
   * @returns Whether this request is still its provider's current one for
   * the same backend while the provider remains available.
   */
  function isCurrentRequest(
    provider: LlmProvider,
    controller: AbortController,
    backendUrl: string
  ): boolean {
    return (
      activeRequests.get(provider) === controller &&
      isProviderAvailable(provider) &&
      dependencies.getBackendConnection().backendUrl === backendUrl
    )
  }

  /**
   * Builds the load step of one model with its current stored configuration.
   * @param provider - Provider whose inventory lists the model.
   * @param modelKey - Key of the model to load.
   * @returns A load step whose configuration is resolved now. The context
   * length is capped at the model's maximum when the inventory lists the
   * model; for an unlisted model no maximum is known and none is applied.
   */
  function buildModelLoadStep(
    provider: LlmProvider,
    modelKey: string
  ): ModelOperationStep {
    const { inventory } = get().providerModels[provider]
    const listedModel =
      inventory.status === "ready"
        ? inventory.models.find((model) => model.modelKey === modelKey)
        : undefined
    const unlistedModel: ModelLoadTarget = { modelKey, maxContextLength: null }
    const configuration = buildModelLoadConfiguration(
      dependencies.getLoadConfigurationSettings(),
      listedModel ?? unlistedModel
    )
    return { kind: "load", modelKey, configuration }
  }

  /**
   * Lists the backend requests one operation consists of, in order.
   * @param operation - Operation being admitted.
   * @returns One step for a read, load, or unload; an unload followed by a
   * load for a reload. Load configurations are sampled here.
   */
  function listModelOperationSteps(
    operation: ModelOperation
  ): readonly ModelOperationStep[] {
    switch (operation.kind) {
      case "inventory-read":
        return [{ kind: "inventory-read" }]
      case "unload":
        return [{ kind: "unload", modelKey: operation.modelKey }]
      case "health-read":
        return [{ kind: "health-read", modelKey: operation.modelKey }]
      case "load":
        return [buildModelLoadStep(operation.provider, operation.modelKey)]
      case "reload":
        return [
          { kind: "unload", modelKey: operation.modelKey },
          buildModelLoadStep(operation.provider, operation.modelKey)
        ]
    }
  }

  /**
   * Publishes the request of the step about to run and clears the previous
   * operation's failure and health observation.
   * @param provider - Provider the step is sent to.
   * @param step - Step about to be sent.
   */
  function handleModelOperationStepStart(
    provider: LlmProvider,
    step: ModelOperationStep
  ): void {
    updateProviderModels(provider, {
      request: buildModelRequest(step),
      error: null,
      health: null
    })
  }

  /**
   * Sends the steps of one admitted operation in order, stopping at the first
   * failure.
   * @param provider - Provider the steps are sent to.
   * @param steps - Steps sampled at admission.
   * @param controller - Identity of the admitted operation.
   * @param connection - Origin and cancellation owned by the operation.
   * @returns What the completed steps established, with the failure of the
   * step that ended them, if any; or null when the operation lost its
   * authority to publish and nothing more may be written.
   */
  async function sendModelOperationSteps(
    provider: LlmProvider,
    steps: readonly ModelOperationStep[],
    controller: AbortController,
    connection: ModelApiConnection
  ): Promise<ModelOperationProgress | null> {
    let progress: ModelOperationProgress = {
      health: null,
      error: null,
      loadedModelConfigurations:
        get().providerModels[provider].loadedModelConfigurations
    }
    for (const step of steps) {
      handleModelOperationStepStart(provider, step)
      if (!isCurrentRequest(provider, controller, connection.backendUrl)) {
        return null
      }
      try {
        progress = await sendModelOperationStep(
          provider,
          step,
          connection,
          progress
        )
      } catch (error) {
        progress = { ...progress, error: formatModelFailure(error) }
      }
      if (!isCurrentRequest(provider, controller, connection.backendUrl)) {
        return null
      }
      if (progress.error !== null) return progress
    }
    return progress
  }

  /**
   * Owns one admitted operation through acknowledgement and reconciliation.
   * @remarks The closing publication records the time the operation
   * settled, which the Model pane reports as the last refresh or check.
   * @param operation - Operation performed without automatically retrying effects.
   * @returns Resolves after settlement, failure presentation, or invalidation.
   */
  async function startModelOperation(operation: ModelOperation): Promise<void> {
    const { provider } = operation
    if (!isProviderAvailable(provider) || activeRequests.has(provider)) return
    const { backendUrl } = dependencies.getBackendConnection()
    const controller = new AbortController()
    const connection: ModelApiConnection = {
      backendUrl,
      signal: controller.signal
    }
    activeRequests.set(provider, controller)
    const progress = await sendModelOperationSteps(
      provider,
      listModelOperationSteps(operation),
      controller,
      connection
    )
    if (progress === null) return
    const result = await readInventoryOutcome(
      provider,
      connection,
      progress.error
    )
    if (!isCurrentRequest(provider, controller, backendUrl)) return
    activeRequests.delete(provider)
    updateProviderModels(provider, {
      inventory: result.inventory,
      error: result.error,
      health: progress.health,
      request: { status: "idle" },
      settledAt: new Date(),
      loadedModelConfigurations: buildProviderLoadedModelConfigurations(
        provider,
        progress.loadedModelConfigurations,
        result.inventory,
        dependencies.getLoadConfigurationSettings()
      )
    })
    if (hasModelRequestFailed(result, progress.health)) {
      await dependencies.handleModelRequestFailure(provider)
    }
  }

  /**
   * Implements {@link ModelActions.releaseProviderModels}: invalidates
   * publication before aborting the corresponding local transport.
   * @param provider - Provider whose model state is released.
   */
  function releaseProviderModels(provider: LlmProvider): void {
    const controller = activeRequests.get(provider)
    activeRequests.delete(provider)
    updateProviderModels(provider, RELEASED_PROVIDER_MODELS)
    controller?.abort()
  }

  return {
    updateModelInventory: (provider) =>
      startModelOperation({ kind: "inventory-read", provider }),
    loadModel: ({ provider, modelKey }) =>
      startModelOperation({ kind: "load", provider, modelKey }),
    updateLoadedModelConfiguration: ({ provider, modelKey }) =>
      startModelOperation({ kind: "reload", provider, modelKey }),
    unloadModel: ({ provider, modelKey }) =>
      startModelOperation({ kind: "unload", provider, modelKey }),
    testModel: ({ provider, modelKey }) =>
      startModelOperation({ kind: "health-read", provider, modelKey }),
    releaseProviderModels
  }
}
