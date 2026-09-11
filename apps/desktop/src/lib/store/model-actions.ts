import type { LlmTestModelApiResponse } from "@lys/protocol"
import type { StoreApi } from "zustand"

import {
  getModelHealth,
  listModels,
  loadModel,
  unloadModel,
  type ModelApiConnection
} from "@/lib/apis/http/models"
import {
  buildModelRuntime,
  initialModelState,
  type ModelInventoryState,
  type ModelRequestState,
  type ModelState
} from "./model-runtime"

/** Connection and selection sampled from the owning application store. */
export type ModelConnectionState = {
  /** Backend origin used by model HTTP consumers. */
  readonly backendUrl: string
  /** Whether the process owner currently admits model requests. */
  readonly isRunning: boolean
  /** Current default used only for the compact residency summary. */
  readonly defaultModel: string | null
}

/** Application model callbacks; request failures are handled in modelError. */
export type ModelActions = {
  /** Queries inventory; resolves after settlement or invalidation, retaining failure in state. */
  updateModelInventory: () => Promise<void>
  /** Loads a key and reconciles inventory; backend work can outlive local observation. */
  loadModel: (modelKey: string) => Promise<void>
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

/**
 * Performs the action before inventory reconciliation.
 * @param request - Admitted action or inventory-only query.
 * @param connection - Origin and cancellation owned by this request.
 * @returns A health observation for testing, otherwise null after completion.
 * @throws The adapter failure for the requested operation.
 */
async function updateModelOperation(
  request: ActiveModelRequest,
  connection: ModelApiConnection
): Promise<LlmTestModelApiResponse | null> {
  switch (request.status) {
    case "listing":
      return null
    case "loading":
      await loadModel(request.modelKey, connection)
      return null
    case "unloading":
      await unloadModel(request.modelKey, connection)
      return null
    case "testing":
      return await getModelHealth(request.modelKey, connection)
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
  /** Action failure, reconciliation failure, or both. */
  readonly modelError: string | null
}

/**
 * Observes inventory without publishing partially settled state.
 * @param connection - Cancellation and origin owned by the admitted operation.
 * @param priorError - Failure of the preceding action, if any.
 * @returns A complete observation result; failures remain visible as unknown state.
 */
async function readInventoryOutcome(
  connection: ModelApiConnection,
  priorError: string | null
): Promise<ModelInventoryOutcome> {
  try {
    const models = await listModels(connection)
    return {
      modelInventory: { status: "ready", models },
      modelError: priorError
    }
  } catch (failure) {
    const message = formatModelFailure(failure)
    return {
      modelInventory: { status: "failed" },
      modelError: priorError
        ? `${priorError} Inventory refresh also failed: ${message}`
        : message
    }
  }
}

/**
 * Registers model callbacks with one Zustand state owner.
 * @param set - Framework setter for atomic model-state updates.
 * @param get - Framework reader for current model state.
 * @param getConnection - Reads current process availability, origin, and selection.
 * @returns Initial model state and callbacks for the application store.
 * @remarks One request is admitted at a time and survives view unmounts.
 * Release invalidates publication before aborting local transport. Accepted
 * backend work can continue after disconnect. Mutations are never retried;
 * their outcomes, including failures, are followed by a fresh inventory query.
 */
export function createModelSlice(
  set: StoreApi<ModelSlice>["setState"],
  get: StoreApi<ModelSlice>["getState"],
  getConnection: () => ModelConnectionState
): ModelSlice {
  let activeRequest: AbortController | null = null

  /**
   * Checks publication authority after an asynchronous boundary.
   * @param controller - Request identity being checked.
   * @param backendUrl - Origin sampled at admission.
   * @returns Whether this request still belongs to the current running backend.
   */
  function isCurrentRequest(
    controller: AbortController,
    backendUrl: string
  ): boolean {
    const connection = getConnection()
    return (
      activeRequest === controller &&
      connection.isRunning &&
      connection.backendUrl === backendUrl
    )
  }

  /**
   * Owns one admitted action through acknowledgement and reconciliation.
   * @param request - Operation performed without automatically retrying effects.
   * @returns Resolves after settlement, failure presentation, or invalidation.
   */
  async function startModelOperation(
    request: ActiveModelRequest
  ): Promise<void> {
    const current = getConnection()
    if (!current.isRunning || activeRequest !== null) return
    const controller = new AbortController()
    const connection: ModelApiConnection = {
      backendUrl: current.backendUrl,
      signal: controller.signal
    }
    activeRequest = controller
    const modelRuntime = buildModelRuntime(
      get().modelInventory,
      request,
      current.defaultModel
    )
    set({
      modelRequest: request,
      modelRuntime,
      modelError: null,
      modelHealth: null
    })
    if (!isCurrentRequest(controller, current.backendUrl)) return
    let modelHealth: LlmTestModelApiResponse | null = null
    let modelError: string | null = null
    try {
      modelHealth = await updateModelOperation(request, connection)
    } catch (failure) {
      modelError = formatModelFailure(failure)
    }
    if (!isCurrentRequest(controller, current.backendUrl)) return
    const result = await readInventoryOutcome(connection, modelError)
    if (!isCurrentRequest(controller, current.backendUrl)) return
    activeRequest = null
    set({
      ...result,
      modelHealth,
      modelRequest: { status: "idle" },
      modelRuntime: buildModelRuntime(
        result.modelInventory,
        { status: "idle" },
        getConnection().defaultModel
      )
    })
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
    updateModelInventory: () => startModelOperation({ status: "listing" }),
    loadModel: (modelKey) =>
      startModelOperation({ status: "loading", modelKey }),
    unloadModel: (modelKey) =>
      startModelOperation({ status: "unloading", modelKey }),
    testModel: (modelKey) =>
      startModelOperation({ status: "testing", modelKey }),
    releaseModelRuntime
  }
}
