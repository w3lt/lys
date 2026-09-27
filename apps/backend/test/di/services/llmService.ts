import {
  llmInfoSchema,
  llmLoadModelApiResponseBodySchema,
  llmTestModelApiParamsSchema,
  type LlmInfo,
  type LlmLoadModelApiResponse
} from "@lys/protocol"
import { createLlmServiceBusyError } from "../../modules/llm/llmServiceBusyError"
import {
  getLlmModelHealth,
  type LlmModelHealthOutcome
} from "../../modules/llm/getLlmModelHealth"
import {
  stopLlmModelsByKey,
  type ListLoadedLlmModelInstances,
  type StopLlmModelsByKeyOutcome
} from "../../modules/llm/stopLlmModelsByKey"
import type {
  LlmModelHealthReader,
  LlmModelInventory,
  LlmModelLoader,
  LlmModelStopper
} from "../../modules/llm/llmModelCapabilities"
import type { LlmEngine } from "../../modules/llm/llmEngine"
import type { DownloadedLlmModel } from "../../modules/llm/llmRuntimeTypes"

/**
 * Runtime capabilities exclusively owned by {@link LlmService}.
 *
 * @remarks Model operations follow {@link LlmEngine}; disposal follows the
 * runtime lifecycle contract supplied at construction. Lifecycle observation
 * remains outside the service because it does not participate in service policy.
 */
interface LlmServiceRuntime extends LlmEngine, AsyncDisposable {}

/** Dependencies supplied when creating an application-scoped LLM service. */
export type LlmServiceCreationOptions = {
  /** Ready runtime that the caller must no longer operate or dispose after construction. */
  readonly runtime: LlmServiceRuntime
  /** Monotonic millisecond clock; defaults to the process performance clock. */
  readonly readMonotonicTimeMs?: () => number
}

/** Lifecycle state that prevents work after runtime cleanup begins. */
type LlmServiceState =
  | Readonly<{
      /** The service accepts model operations. */
      status: "ready"
    }>
  | Readonly<{
      /** Cleanup is waiting for queued work or releasing the client. */
      status: "closing"
      /** Shared completion joined by concurrent cleanup calls. */
      completion: Promise<void>
    }>
  | Readonly<{
      /** Cleanup settled and model operations are permanently rejected. */
      status: "closed"
      /** Settled cleanup result reused by repeated cleanup calls. */
      completion: Promise<void>
    }>

/** Ready service state established before input validation or queue admission. */
type ReadyLlmServiceState = Extract<LlmServiceState, { status: "ready" }>

/**
 * Work accepted by the serialized application operation queue.
 *
 * @typeParam Result - Immutable result or owned value produced by the work.
 */
type LlmServiceOperation<Result> = () => Promise<Result>

/** Private admission count and completion tail for the service's FIFO queue. */
type LlmServiceQueueState = {
  /** Completion of every accepted operation, preserving progress after failure. */
  completion: Promise<void>
  /** Accepted operations that have not settled, including the active operation. */
  acceptedOperationCount: number
}

/**
 * Inclusive service capacity: one active operation and eight waiting operations.
 *
 * @remarks The first operation reserves the active position at admission, before
 * its execution microtask starts. Excess requests are rejected without waiting.
 */
const MAX_ACCEPTED_LLM_SERVICE_OPERATIONS = 9

/** Initial state for an LLM service that can accept model operations. */
const READY_LLM_SERVICE_STATE = Object.freeze({
  status: "ready"
} as const satisfies LlmServiceState)

/** Stable failure text for model operations requested after cleanup begins. */
const CLOSED_LLM_SERVICE_MESSAGE = "The LLM runtime is closed."

/**
 * Owns one LLM runtime for serialized model loading, inventory, and stopping.
 *
 * @remarks The instance
 * exclusively owns the supplied runtime and coordinates complete application
 * operations through its provider-independent contract. Its invariant is
 * `ready -> closing -> closed`; cleanup is terminal and idempotent.
 * Concurrency model: serialized;
 * accepted model operations run one at a time in admission order, with at most
 * eight additional operations waiting. Excess requests fail before admission
 * with a recognized service-busy error. Cleanup waits for all accepted work.
 * By product design, users cannot cancel accepted loads or unloads. This service
 * owns queued and active model operations independently of client connections,
 * including inventory queries needed to finish each operation. No completion
 * deadline is enforced; a dependency that never settles also prevents cleanup
 * from completing.
 * Implements {@link LlmModelHealthReader}, {@link LlmModelInventory},
 * {@link LlmModelLoader}, and {@link LlmModelStopper} through the same owned
 * runtime and lifecycle.
 */
export default class LlmService
  implements
    LlmModelHealthReader,
    LlmModelInventory,
    LlmModelLoader,
    LlmModelStopper
{
  /** Exclusively owned model runtime; only this service may dispose it. */
  readonly #runtime: LlmServiceRuntime

  /** Borrowed monotonic clock used only around admitted health queries. */
  readonly #readMonotonicTimeMs: () => number

  /** Exclusively owned admission accounting and terminal observation for queued work. */
  readonly #operationQueue: LlmServiceQueueState = {
    completion: Promise.resolve(),
    acceptedOperationCount: 0
  }

  /** Authoritative lifecycle state controlling work admission and cleanup. */
  #state: LlmServiceState = READY_LLM_SERVICE_STATE

  /**
   * Creates a ready service and takes exclusive ownership of its runtime.
   *
   * @param options - Ready runtime whose ownership transfers and optional borrowed clock.
   */
  constructor({
    runtime,
    readMonotonicTimeMs = readPerformanceNowMs
  }: LlmServiceCreationOptions) {
    this.#runtime = runtime
    this.#readMonotonicTimeMs = readMonotonicTimeMs
  }

  /**
   * Implements {@link LlmModelHealthReader.getLlmModelHealth} through its owned runtime.
   *
   * @param modelKey - Raw canonical-key candidate validated after lifecycle observation and before admission.
   * @returns A promise resolving to validated immutable health and internal diagnostics.
   * @throws If the candidate is empty or exceeds the protocol limit, response
   * validation fails, queue capacity is exhausted, or cleanup has begun;
   * inventory failure is represented by a `runtime-unavailable` outcome.
   * @remarks Queue waiting is excluded from measured latency. The service owns
   * accepted health work through settlement after client disconnect.
   */
  public async getLlmModelHealth(
    modelKey: string
  ): Promise<LlmModelHealthOutcome> {
    this.#getReadyLlmServiceState()
    const { modelId } = llmTestModelApiParamsSchema.parse({ modelId: modelKey })
    return await this.#handleLlmServiceOperationRequest(
      async () =>
        await getLlmModelHealth(
          modelId,
          async () => await this.#runtime.listLoadedLlmModelInstances(),
          this.#readMonotonicTimeMs
        )
    )
  }

  /**
   * Implements {@link LlmModelLoader.loadLlmModel} through its owned runtime.
   *
   * @param modelKeyOrAlias - Model key or alias for the attached runtime to resolve.
   * @returns A promise resolving to a validated immutable model snapshot after
   * the runtime loads the model and its canonical key is found in inventory.
   * @throws If loading or inventory fails, the canonical model is absent from
   * inventory, application response validation fails, queue capacity is exhausted,
   * or cleanup has begun.
   * @remarks The service owns the full load and inventory-query lifetime;
   * client disconnect does not cancel accepted work.
   */
  public async loadLlmModel(
    modelKeyOrAlias: string
  ): Promise<LlmLoadModelApiResponse> {
    return await this.#handleLlmServiceOperationRequest(
      async () =>
        await loadRuntimeLlmModel(
          modelKeyOrAlias,
          async (selection) => await this.#runtime.loadLlmModel(selection),
          async () => await this.#runtime.listDownloadedLlmModels()
        )
    )
  }

  /**
   * Implements {@link LlmModelInventory.listLlmModels} through its owned runtime.
   *
   * @returns A promise resolving to snapshots ordered by ascending canonical model key.
   * @throws If an inventory query fails, queue capacity is exhausted, or cleanup has begun.
   * @remarks The service owns both completion-only inventory queries until
   * they settle, including after the requesting client disconnects.
   */
  public async listLlmModels(): Promise<readonly LlmInfo[]> {
    return await this.#handleLlmServiceOperationRequest(
      async () =>
        await listLlmModels(
          async () => await this.#runtime.listDownloadedLlmModels(),
          async () => await this.#runtime.listLoadedLlmModelInstances()
        )
    )
  }

  /**
   * Implements {@link LlmModelStopper.stopLlmModelsByKey} through its owned runtime.
   *
   * @param modelKey - Canonical model key shared by the instances to stop.
   * @returns A promise resolving to the immutable outcome from a fresh reconciliation snapshot.
   * @throws If queue capacity is exhausted or cleanup has begun; runtime-operation
   * failures are represented in the returned outcome.
   * @remarks Accepted work remains owned by the service through stop attempts
   * and reconciliation; client disconnect does not cancel it.
   */
  public async stopLlmModelsByKey(
    modelKey: string
  ): Promise<StopLlmModelsByKeyOutcome> {
    return await this.#handleLlmServiceOperationRequest(
      async () =>
        await stopLlmModelsByKey(
          modelKey,
          async () => await this.#runtime.listLoadedLlmModelInstances(),
          async (identifier) =>
            await this.#runtime.stopLoadedLlmModelInstance(identifier)
        )
    )
  }

  /**
   * Disposes the owned runtime after every accepted operation settles.
   *
   * @returns A promise shared by concurrent and repeated cleanup calls.
   * @throws If the owned runtime cannot release its resources; the service remains terminally closed.
   * @remarks Cleanup is idempotent and rejects every model operation requested after it begins.
   */
  public async [Symbol.asyncDispose](): Promise<void> {
    if (this.#state.status !== "ready") {
      await this.#state.completion
      return
    }

    const cleanupCompletion = this.#operationQueue.completion.then(
      async () => await this.#runtime[Symbol.asyncDispose]()
    )
    this.#state = Object.freeze({
      status: "closing",
      completion: cleanupCompletion
    })

    try {
      await cleanupCompletion
    } finally {
      this.#state = Object.freeze({
        status: "closed",
        completion: cleanupCompletion
      })
    }
  }

  /**
   * Adds one model operation to the service's serialized work queue.
   *
   * @param operation - Deferred operation that accesses the owned runtime.
   * @returns A promise resolving to the operation result after earlier accepted work settles.
   * @throws If cleanup has begun, queue capacity is exhausted, or the operation rejects.
   * @remarks Admission reserves capacity synchronously. Completion releases it
   * on success or failure before the caller observes the operation's outcome.
   */
  #handleLlmServiceOperationRequest<Result>(
    operation: LlmServiceOperation<Result>
  ): Promise<Result> {
    this.#getReadyLlmServiceState()

    if (
      this.#operationQueue.acceptedOperationCount >=
      MAX_ACCEPTED_LLM_SERVICE_OPERATIONS
    ) {
      return Promise.reject(createLlmServiceBusyError())
    }

    this.#operationQueue.acceptedOperationCount += 1
    const operationResult = this.#operationQueue.completion.then(
      async () => await this.#handleAcceptedLlmServiceOperation(operation)
    )
    this.#operationQueue.completion = operationResult.then(
      () => undefined,
      () => undefined
    )
    return operationResult
  }

  /**
   * Gets the ready lifecycle state or rejects every operation after cleanup begins.
   *
   * @returns The current ready state authorizing validation and queue admission.
   * @throws The canonical closed-runtime failure after cleanup begins.
   */
  #getReadyLlmServiceState(): ReadyLlmServiceState {
    if (this.#state.status !== "ready") {
      throw new Error(CLOSED_LLM_SERVICE_MESSAGE)
    }

    return this.#state
  }

  /**
   * Completes one accepted operation and releases its reserved queue capacity.
   *
   * @typeParam Result - Result returned by the accepted operation.
   * @param operation - Accepted work whose predecessors have settled.
   * @returns The original operation result after its capacity is released.
   * @throws The original operation failure after its capacity is released.
   */
  async #handleAcceptedLlmServiceOperation<Result>(
    operation: LlmServiceOperation<Result>
  ): Promise<Result> {
    try {
      return await operation()
    } finally {
      this.#operationQueue.acceptedOperationCount -= 1
    }
  }
}

/**
 * Lists downloaded LLMs annotated from the current loaded-instance snapshot.
 *
 * @param listDownloadedLlmModels - Query for normalized immutable runtime metadata.
 * @param listLoadedLlmModelInstances - Query for immutable loaded-instance records.
 * @returns A promise resolving to a transitively immutable, newly owned model inventory.
 * @throws If either inventory query fails.
 */
async function listLlmModels(
  listDownloadedLlmModels: LlmEngine["listDownloadedLlmModels"],
  listLoadedLlmModelInstances: ListLoadedLlmModelInstances
): Promise<readonly LlmInfo[]> {
  const downloadedLlmModels = await listDownloadedLlmModels()
  const loadedLlmModelInstances = await listLoadedLlmModelInstances()
  const loadedModelKeys = new Set(
    loadedLlmModelInstances.map(({ modelKey }) => modelKey)
  )
  const llmModels = downloadedLlmModels
    .map((downloadedLlmModel) =>
      createLlmInfoSnapshot(
        downloadedLlmModel,
        loadedModelKeys.has(downloadedLlmModel.modelKey)
      )
    )
    .toSorted(calculateLlmInfoOrder)

  return Object.freeze(llmModels)
}

/**
 * Loads a model and resolves its canonical downloaded-model metadata.
 *
 * @param modelKeyOrAlias - Model key or alias passed to the attached runtime.
 * @param loadLlmModel - Command returning the loaded model's validated identity.
 * @param listDownloadedLlmModels - Query for normalized immutable runtime metadata.
 * @returns A promise resolving to a validated immutable loaded-model snapshot.
 * @throws If loading or inventory fails, metadata is invalid, or the canonical
 * model is absent from downloaded inventory.
 */
async function loadRuntimeLlmModel(
  modelKeyOrAlias: string,
  loadLlmModel: LlmEngine["loadLlmModel"],
  listDownloadedLlmModels: LlmEngine["listDownloadedLlmModels"]
): Promise<LlmLoadModelApiResponse> {
  const loadedModelInstance = await loadLlmModel(modelKeyOrAlias)
  const downloadedLlmModels = await listDownloadedLlmModels()
  const downloadedLlmModel = downloadedLlmModels.find(
    ({ modelKey }) => modelKey === loadedModelInstance.modelKey
  )

  if (downloadedLlmModel === undefined) {
    throw new Error(
      `Loaded model "${loadedModelInstance.modelKey}" was not found in the downloaded LLM inventory`
    )
  }

  return llmLoadModelApiResponseBodySchema.parse(
    createLlmInfoSnapshot(downloadedLlmModel, true)
  )
}

/**
 * Adds application loaded state to normalized runtime metadata.
 *
 * @param downloadedLlmModel - Trusted immutable metadata returned by the runtime.
 * @param isLoaded - Whether a loaded-instance snapshot contains this model key.
 * @returns A newly owned transitively immutable protocol snapshot.
 * @throws If the resulting application response does not satisfy its schema.
 */
function createLlmInfoSnapshot(
  downloadedLlmModel: DownloadedLlmModel,
  isLoaded: boolean
): LlmInfo {
  return llmInfoSchema.parse({ ...downloadedLlmModel, loaded: isLoaded })
}

/**
 * Calculates deterministic ascending order for model inventory snapshots.
 *
 * @param left - First model snapshot to compare.
 * @param right - Second model snapshot to compare.
 * @returns A negative value when `left` precedes `right`, a positive value when
 * `right` precedes `left`, and zero when their keys and paths are equal.
 */
function calculateLlmInfoOrder(left: LlmInfo, right: LlmInfo): number {
  if (left.modelKey < right.modelKey) {
    return -1
  }
  if (left.modelKey > right.modelKey) {
    return 1
  }
  if (left.path < right.path) {
    return -1
  }
  if (left.path > right.path) {
    return 1
  }
  return 0
}

/**
 * Reads the process monotonic clock for production health measurements.
 *
 * @returns Current process-relative monotonic time in milliseconds.
 */
function readPerformanceNowMs(): number {
  return performance.now()
}
