import {
  llmInfoSchema,
  llmLoadModelApiResponseBodySchema,
  llmTestModelApiParamsSchema,
  type LlmInfo,
  type LlmLoadModelApiResponse
} from "@lys/protocol"
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
 * One model operation performed against the connected engine.
 *
 * @typeParam Result - Result produced by the operation.
 */
export type LlmEngineOperation<Result> = (
  llmEngine: LlmEngine
) => Promise<Result>

/**
 * Serializes model operations against the connected LLM engine for {@link LlmService}.
 *
 * @remarks Implementations are ready when injected and own the runtime,
 * capacity, ordering, and cleanup. Accepted operations run one at a time in
 * admission order with at most eight waiting; the provider owns accepted work
 * until it settles, independently of the requesting client. No completion
 * deadline is guaranteed.
 */
export interface LlmEngineOperationQueue {
  /**
   * Performs one model operation after earlier accepted work settles.
   *
   * @typeParam Result - Result produced by the operation.
   * @param operation - Operation receiving an engine valid until it settles.
   * @returns The operation's result.
   * @throws `The LLM runtime is closed.` after cleanup begins.
   * @throws A runtime-unavailable error recognized by
   * [isLlmRuntimeUnavailableError](../../modules/llm/llmRuntimeUnavailableError.ts)
   * when no runtime is connected, or when a failed runtime call revealed that
   * the runtime stopped answering (the error retains the original failure).
   * @throws A service-busy error when the queue is full; the operation is not accepted.
   * @throws The operation's own failure otherwise.
   * @remarks A resolved result is returned even when the runtime is released
   * after the operation because one of its runtime calls failed.
   */
  handleLlmEngineOperationRequest<Result>(
    operation: LlmEngineOperation<Result>
  ): Promise<Result>
}

/** Dependencies supplied when creating an application-scoped LLM service. */
export type LlmServiceCreationOptions = {
  /** Borrowed queue that serializes every model operation against the connected runtime. */
  readonly llmEngineOperationQueue: LlmEngineOperationQueue
  /** Monotonic millisecond clock; defaults to the process performance clock. */
  readonly readMonotonicTimeMs?: () => number
}

/**
 * Applies model policy to operations serialized by the LLM runtime queue.
 *
 * @remarks Owns no mutable state or resource. It borrows the operation queue,
 * whose owner holds the runtime, admits work only while connected, and
 * enforces capacity, ordering, completion ownership, and cleanup. Each
 * operation composes its policy with the engine supplied for that operation.
 * By product design, users cannot cancel accepted loads or unloads.
 * Concurrency model: reentrant; overlapping calls are serialized by the
 * borrowed queue, not by this class.
 * Implements {@link LlmModelHealthReader}, {@link LlmModelInventory},
 * {@link LlmModelLoader}, and {@link LlmModelStopper}.
 */
export default class LlmService
  implements
    LlmModelHealthReader,
    LlmModelInventory,
    LlmModelLoader,
    LlmModelStopper
{
  /** Borrowed queue that owns the runtime and every accepted operation. */
  readonly #llmEngineOperationQueue: LlmEngineOperationQueue

  /** Borrowed monotonic clock used only around admitted health queries. */
  readonly #readMonotonicTimeMs: () => number

  /**
   * Creates a ready service over a borrowed operation queue.
   *
   * @param options - Borrowed queue and optional monotonic clock.
   */
  public constructor({
    llmEngineOperationQueue,
    readMonotonicTimeMs = readPerformanceNowMs
  }: LlmServiceCreationOptions) {
    this.#llmEngineOperationQueue = llmEngineOperationQueue
    this.#readMonotonicTimeMs = readMonotonicTimeMs
  }

  /**
   * Implements {@link LlmModelHealthReader.getLlmModelHealth} through the queue.
   *
   * @param modelKey - Raw canonical-key candidate validated before queue admission.
   * @returns A promise resolving to validated immutable health and internal diagnostics.
   * @throws If the candidate is empty or exceeds the protocol limit, before any
   * lifecycle or connection check; otherwise the queue's closed,
   * runtime-unavailable, and service-busy failures. Inventory failure is
   * represented by a `runtime-unavailable` outcome.
   * @remarks Queue waiting is excluded from measured latency.
   */
  public async getLlmModelHealth(
    modelKey: string
  ): Promise<LlmModelHealthOutcome> {
    const { modelId } = llmTestModelApiParamsSchema.parse({ modelId: modelKey })
    return await this.#llmEngineOperationQueue.handleLlmEngineOperationRequest(
      async (llmEngine) =>
        await getLlmModelHealth(
          modelId,
          async () => await llmEngine.listLoadedLlmModelInstances(),
          this.#readMonotonicTimeMs
        )
    )
  }

  /**
   * Implements {@link LlmModelLoader.loadLlmModel} through the queue.
   *
   * @param modelKeyOrAlias - Model key or alias for the connected runtime to resolve.
   * @returns A promise resolving to a validated immutable model snapshot after
   * the runtime loads the model and its canonical key is found in inventory.
   * @throws If loading or inventory fails, the canonical model is absent,
   * response validation fails, or the queue rejects the operation.
   */
  public async loadLlmModel(
    modelKeyOrAlias: string
  ): Promise<LlmLoadModelApiResponse> {
    return await this.#llmEngineOperationQueue.handleLlmEngineOperationRequest(
      async (llmEngine) =>
        await loadRuntimeLlmModel(
          modelKeyOrAlias,
          async (selection) => await llmEngine.loadLlmModel(selection),
          async () => await llmEngine.listDownloadedLlmModels()
        )
    )
  }

  /**
   * Implements {@link LlmModelInventory.listLlmModels} through the queue.
   *
   * @returns A promise resolving to snapshots ordered by ascending canonical model key.
   * @throws If an inventory query fails or the queue rejects the operation.
   */
  public async listLlmModels(): Promise<readonly LlmInfo[]> {
    return await this.#llmEngineOperationQueue.handleLlmEngineOperationRequest(
      async (llmEngine) =>
        await listLlmModels(
          async () => await llmEngine.listDownloadedLlmModels(),
          async () => await llmEngine.listLoadedLlmModelInstances()
        )
    )
  }

  /**
   * Implements {@link LlmModelStopper.stopLlmModelsByKey} through the queue.
   *
   * @param modelKey - Canonical model key shared by the instances to stop.
   * @returns A promise resolving to the immutable outcome from a fresh reconciliation snapshot.
   * @throws If the queue rejects the operation; runtime-operation failures are
   * represented in the returned outcome.
   */
  public async stopLlmModelsByKey(
    modelKey: string
  ): Promise<StopLlmModelsByKeyOutcome> {
    return await this.#llmEngineOperationQueue.handleLlmEngineOperationRequest(
      async (llmEngine) =>
        await stopLlmModelsByKey(
          modelKey,
          async () => await llmEngine.listLoadedLlmModelInstances(),
          async (identifier) =>
            await llmEngine.stopLoadedLlmModelInstance(identifier)
        )
    )
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
