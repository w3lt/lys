import type { LlmTestModelApiResponse } from "@lys/protocol"
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
  buildModelRuntime,
  initialModelState,
  removeLoadedModelConfiguration,
  type LoadedModelConfigurations,
  type ModelInventoryState,
  type ModelRequestState,
  type ModelState
} from "./model-runtime"
import type {
  CompleteModelLoadConfiguration,
  LoadConfigurationSettings
} from "./settings"

/** Connection and selection sampled from the owning application store. */
export type ModelConnectionState = {
  /** Backend origin used by model HTTP consumers. */
  readonly backendUrl: string
  /** Whether the backend runs and LM Studio is connected, so model requests are admitted. */
  readonly isModelRuntimeAvailable: boolean
  /** Current default used only for the compact residency summary. */
  readonly defaultModel: string | null
}

/** Store capabilities the model slice reads and notifies. */
export type ModelSliceDependencies = {
  /** Reads current model-runtime availability, origin, and selection. */
  readonly getConnection: () => ModelConnectionState
  /**
   * Re-reads the LM Studio status after a request failed or reported an
   * unavailable runtime.
   *
   * @remarks Resolves after the status settles and never rejects.
   */
  readonly handleModelRequestFailure: () => Promise<void>
  /**
   * Reads the stored default and per-model load settings.
   *
   * @remarks Sampled when a load is admitted, so later edits do not change
   * the settings that load sends, and when an inventory observation finds a
   * model already loaded.
   */
  readonly getLoadConfigurationSettings: () => LoadConfigurationSettings
}

/**
 * Application model callbacks; request failures are handled in modelError,
 * except an inventory query that finds no connected LLM runtime, which the LM
 * Studio status explains instead.
 */
export type ModelActions = {
  /** Queries inventory; resolves after settlement or invalidation, retaining failure in state. */
  updateModelInventory: () => Promise<void>
  /**
   * Loads a key with its stored load configuration and reconciles inventory;
   * backend work can outlive local observation.
   */
  loadModel: (modelKey: string) => Promise<void>
  /**
   * Applies the stored load configuration to a loaded model: unloads every
   * instance of the key, then loads it again, and reconciles inventory.
   *
   * @remarks The published request is `unloading`, then `loading`. A failed
   * unload starts no load. A load that fails after the unload leaves the
   * model unloaded, with the failure in modelError.
   */
  updateLoadedModelConfiguration: (modelKey: string) => Promise<void>
  /** Unloads all instances of a key and reconciles inventory, including after failure. */
  unloadModel: (modelKey: string) => Promise<void>
  /** Queries loaded-state health without performing inference. */
  testModel: (modelKey: string) => Promise<void>
  /** Invalidates local observations and aborts transport without unloading LM Studio weights. */
  releaseModelRuntime: () => void
}

/** Model state and callbacks composed into the application store. */
export type ModelSlice = ModelState & ModelActions

/** An admitted request, excluding the idle marker. */
type ActiveModelRequest = Exclude<ModelRequestState, { status: "idle" }>

/** Model operation a caller asks the slice to perform. */
type ModelOperation =
  | {
      /** Reads the inventory without changing the runtime. */
      readonly kind: "inventory-read"
    }
  | {
      /** Loads, unloads, reads the health of, or reloads one model. */
      readonly kind: "load" | "unload" | "health-read" | "reload"
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
  readonly modelHealth: LlmTestModelApiResponse | null
  /** Failure of the step that ended the operation, otherwise null. */
  readonly modelError: string | null
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
 * @param step - Step to send.
 * @param connection - Origin and cancellation owned by the operation.
 * @param progress - What the earlier steps established; not modified.
 * @returns New progress: a completed load records the configuration it was
 * sent with under the canonical key the backend reports, a completed unload
 * removes the model's record, and a health read records its observation.
 * @throws The adapter failure for the step; the progress is then unchanged.
 */
async function sendModelOperationStep(
  step: ModelOperationStep,
  connection: ModelApiConnection,
  progress: ModelOperationProgress
): Promise<ModelOperationProgress> {
  switch (step.kind) {
    case "inventory-read":
      return progress
    case "load": {
      const loaded = await loadModel(
        step.modelKey,
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
      await unloadModel(step.modelKey, connection)
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
        modelHealth: await getModelHealth(step.modelKey, connection)
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
  readonly modelInventory: ModelInventoryState
  /** Action failure, reconciliation failure, or both; excludes an inventory query that found no connected LLM runtime. */
  readonly modelError: string | null
  /** Whether the inventory read found no connected LLM runtime. */
  readonly isModelRuntimeUnavailable: boolean
}

/**
 * Observes inventory without publishing partially settled state.
 * @param connection - Cancellation and origin owned by the admitted operation.
 * @param priorError - Failure of the preceding action, if any.
 * @returns A complete observation result; failures remain visible as unknown
 * state, except a missing LLM runtime, which leaves inventory unavailable
 * without a model error because the LM Studio status explains it.
 */
async function readInventoryOutcome(
  connection: ModelApiConnection,
  priorError: string | null
): Promise<ModelInventoryOutcome> {
  try {
    const models = await listModels(connection)
    return {
      modelInventory: { status: "ready", models },
      modelError: priorError,
      isModelRuntimeUnavailable: false
    }
  } catch (error) {
    if (isModelRuntimeUnavailableError(error)) {
      return {
        modelInventory: { status: "unavailable" },
        modelError: priorError,
        isModelRuntimeUnavailable: true
      }
    }
    const message = formatModelFailure(error)
    return {
      modelInventory: { status: "failed" },
      modelError: priorError
        ? `${priorError} Inventory refresh also failed: ${message}`
        : message,
      isModelRuntimeUnavailable: false
    }
  }
}

/**
 * Determines whether a settled request warrants a fresh LM Studio status.
 *
 * @param result - Published inventory observation and failure.
 * @param modelHealth - Health observation from a test request, if any.
 * @returns Whether the action or reconciliation failed, or health reported an
 * unavailable runtime.
 */
function hasModelRequestFailed(
  result: ModelInventoryOutcome,
  modelHealth: LlmTestModelApiResponse | null
): boolean {
  if (result.modelError !== null || result.isModelRuntimeUnavailable) {
    return true
  }
  return (
    modelHealth?.status === "not-ready" &&
    modelHealth.reason === "runtime-unavailable"
  )
}

/**
 * Registers model callbacks with one Zustand state owner.
 * @param set - Framework setter for atomic model-state updates.
 * @param get - Framework reader for current model state.
 * @param dependencies - Availability reader and the failure reaction owned by the store.
 * @returns Initial model state and callbacks for the application store.
 * @remarks One request is admitted at a time and survives view unmounts.
 * Release invalidates publication before aborting local transport. Accepted
 * backend work can continue after disconnect. Mutations are never retried;
 * their outcomes, including failures, are followed by a fresh inventory query.
 * A load sends the model's stored load configuration as sampled at admission,
 * and the slice remembers what it sent for as long as the model stays
 * observed as loaded; release discards those records.
 * A settled request that failed, or whose health reported an unavailable
 * runtime, awaits the store's LM Studio status refresh before resolving.
 */
export function createModelSlice(
  set: StoreApi<ModelSlice>["setState"],
  get: StoreApi<ModelSlice>["getState"],
  dependencies: ModelSliceDependencies
): ModelSlice {
  let activeRequest: AbortController | null = null

  /**
   * Checks publication authority after an asynchronous boundary.
   * @param controller - Request identity being checked.
   * @param backendUrl - Origin sampled at admission.
   * @returns Whether this request is still current for the same backend while
   * the model runtime remains available.
   */
  function isCurrentRequest(
    controller: AbortController,
    backendUrl: string
  ): boolean {
    const connection = dependencies.getConnection()
    return (
      activeRequest === controller &&
      connection.isModelRuntimeAvailable &&
      connection.backendUrl === backendUrl
    )
  }

  /**
   * Builds the load step of one model with its current stored configuration.
   * @param modelKey - Key of the model to load.
   * @returns A load step whose configuration is resolved now. The context
   * length is capped at the model's maximum when the inventory lists the
   * model; for an unlisted model no maximum is known and none is applied.
   */
  function buildModelLoadStep(modelKey: string): ModelOperationStep {
    const inventory = get().modelInventory
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
        return [buildModelLoadStep(operation.modelKey)]
      case "reload":
        return [
          { kind: "unload", modelKey: operation.modelKey },
          buildModelLoadStep(operation.modelKey)
        ]
    }
  }

  /**
   * Publishes the request of the step about to run and clears the previous
   * operation's failure and health observation.
   * @param step - Step about to be sent.
   */
  function handleModelOperationStepStart(step: ModelOperationStep): void {
    const modelRequest = buildModelRequest(step)
    set({
      modelRequest,
      modelRuntime: buildModelRuntime(
        get().modelInventory,
        modelRequest,
        dependencies.getConnection().defaultModel
      ),
      modelError: null,
      modelHealth: null
    })
  }

  /**
   * Sends the steps of one admitted operation in order, stopping at the first
   * failure.
   * @param steps - Steps sampled at admission.
   * @param controller - Identity of the admitted operation.
   * @param connection - Origin and cancellation owned by the operation.
   * @returns What the completed steps established, with the failure of the
   * step that ended them, if any; or null when the operation lost its
   * authority to publish and nothing more may be written.
   */
  async function sendModelOperationSteps(
    steps: readonly ModelOperationStep[],
    controller: AbortController,
    connection: ModelApiConnection
  ): Promise<ModelOperationProgress | null> {
    let progress: ModelOperationProgress = {
      modelHealth: null,
      modelError: null,
      loadedModelConfigurations: get().loadedModelConfigurations
    }
    for (const step of steps) {
      handleModelOperationStepStart(step)
      if (!isCurrentRequest(controller, connection.backendUrl)) return null
      try {
        progress = await sendModelOperationStep(step, connection, progress)
      } catch (error) {
        progress = { ...progress, modelError: formatModelFailure(error) }
      }
      if (!isCurrentRequest(controller, connection.backendUrl)) return null
      if (progress.modelError !== null) return progress
    }
    return progress
  }

  /**
   * Owns one admitted operation through acknowledgement and reconciliation.
   * @param operation - Operation performed without automatically retrying effects.
   * @returns Resolves after settlement, failure presentation, or invalidation.
   */
  async function startModelOperation(operation: ModelOperation): Promise<void> {
    const current = dependencies.getConnection()
    if (!current.isModelRuntimeAvailable || activeRequest !== null) return
    const controller = new AbortController()
    const connection: ModelApiConnection = {
      backendUrl: current.backendUrl,
      signal: controller.signal
    }
    activeRequest = controller
    const progress = await sendModelOperationSteps(
      listModelOperationSteps(operation),
      controller,
      connection
    )
    if (progress === null) return
    const result = await readInventoryOutcome(connection, progress.modelError)
    if (!isCurrentRequest(controller, current.backendUrl)) return
    activeRequest = null
    set({
      modelInventory: result.modelInventory,
      modelError: result.modelError,
      modelHealth: progress.modelHealth,
      modelRequest: { status: "idle" },
      modelRuntime: buildModelRuntime(
        result.modelInventory,
        { status: "idle" },
        dependencies.getConnection().defaultModel
      ),
      loadedModelConfigurations: buildLoadedModelConfigurations(
        progress.loadedModelConfigurations,
        result.modelInventory,
        dependencies.getLoadConfigurationSettings()
      )
    })
    if (hasModelRequestFailed(result, progress.modelHealth)) {
      await dependencies.handleModelRequestFailure()
    }
  }

  /** Invalidates publication before aborting the corresponding local transport. */
  function releaseModelRuntime(): void {
    const controller = activeRequest
    activeRequest = null
    set(initialModelState)
    controller?.abort()
  }

  return {
    ...initialModelState,
    updateModelInventory: () => startModelOperation({ kind: "inventory-read" }),
    loadModel: (modelKey) => startModelOperation({ kind: "load", modelKey }),
    updateLoadedModelConfiguration: (modelKey) =>
      startModelOperation({ kind: "reload", modelKey }),
    unloadModel: (modelKey) =>
      startModelOperation({ kind: "unload", modelKey }),
    testModel: (modelKey) =>
      startModelOperation({ kind: "health-read", modelKey }),
    releaseModelRuntime
  }
}
