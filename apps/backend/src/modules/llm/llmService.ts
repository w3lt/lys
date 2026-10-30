import {
  llmInfoSchema,
  llmLoadModelApiResponseBodySchema,
  llmTestModelApiParamsSchema,
  type LlmInfo,
  type LlmListModelsApiResponse,
  type LlmLoadModelApiResponse
} from "@lys/protocol"
import type { ModelLoadConfiguration } from "@lys/share"
import {
  getLlmModelHealth,
  type LlmModelHealthOutcome
} from "./getLlmModelHealth"
import {
  stopLlmModelsByKey,
  type ListLoadedLlmModelInstances,
  type StopLlmModelsByKeyOutcome
} from "./stopLlmModelsByKey"
import type {
  LlmModelHealthReader,
  LlmModelInventory,
  LlmModelLoader,
  LlmModelStopper
} from "./llmModelCapabilities"
import type { LlmEngine } from "./llmEngine"
import type { LlmModelInstanceController } from "./llmModelInstanceController"
import { createLlmProviderLoadsModelsError } from "./llmProviderLoadsModelsError"
import type {
  DownloadedLlmModel,
  LlmContextMeasurement,
  LoadedLlmModelInstance
} from "./llmRuntimeTypes"

/**
 * The connected engine as one model operation sees it, with who loads its
 * models.
 *
 * @remarks Both capabilities stay valid until the operation settles.
 */
export type ConnectedLlmEngine =
  | Readonly<{
      /** The provider decides which models are in memory. */
      modelLoading: "provider"
      /** Observes the engine's models and measures contexts. */
      llmEngine: LlmEngine
    }>
  | Readonly<{
      /** A model answers only once Lys loads it. */
      modelLoading: "lys"
      /** Observes the engine's models and measures contexts. */
      llmEngine: LlmEngine
      /** Loads the engine's models and stops their instances. */
      llmModelInstanceController: LlmModelInstanceController
    }>

/**
 * One model operation performed against the connected engine.
 *
 * @typeParam Result - Result produced by the operation.
 */
export type LlmEngineOperation<Result> = (
  connectedLlmEngine: ConnectedLlmEngine
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
   * @param operation - Operation receiving the connected engine, valid until
   * it settles.
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
 * Loaded state the service adds to a downloaded model's metadata; only a
 * loaded model can carry a context length.
 */
type LlmLoadedState =
  | Readonly<{
      /** No loaded instance belongs to the model. */
      loaded: false
    }>
  | Readonly<{
      /** At least one loaded instance belongs to the model. */
      loaded: true
      /**
       * Smallest context length among its loaded instances, in tokens;
       * absent when it was not observed.
       */
      loadedContextLength?: number
    }>

/** State of a model no loaded instance belongs to. */
const NOT_LOADED: LlmLoadedState = Object.freeze({ loaded: false })

/**
 * State of a loaded model whose context length was not observed: after a
 * load, or when its instances were gone by the time they were measured.
 */
const LOADED_WITHOUT_CONTEXT_LENGTH: LlmLoadedState = Object.freeze({
  loaded: true
})

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
 * {@link LlmModelLoader}, and {@link LlmModelStopper}, measures contexts for
 * chat replies, and lists the downloaded models whose capabilities a chat
 * turn reads.
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
      async ({ llmEngine }) =>
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
   * @param loadConfiguration - Interface-defined load settings, passed to the
   * connected runtime unchanged.
   * @returns A promise resolving to a validated immutable model snapshot after
   * the runtime loads the model and its canonical key is found in inventory.
   * @throws If loading or inventory fails, response validation fails, or the
   * queue rejects the operation.
   * @throws An `Error` with the message `Loaded model "<canonical model key>"
   * was not found in the downloaded LLM inventory` if the canonical model is
   * absent from inventory after loading.
   * @throws The provider-loads-models refusal when the connected provider
   * loads its own models.
   */
  public async loadLlmModel(
    modelKeyOrAlias: string,
    loadConfiguration: ModelLoadConfiguration
  ): Promise<LlmLoadModelApiResponse> {
    return await this.#llmEngineOperationQueue.handleLlmEngineOperationRequest(
      async (connectedLlmEngine) => {
        if (connectedLlmEngine.modelLoading === "provider") {
          throw createLlmProviderLoadsModelsError()
        }
        const { llmEngine, llmModelInstanceController } = connectedLlmEngine
        return await loadRuntimeLlmModel(
          async () =>
            await llmModelInstanceController.loadLlmModel(
              modelKeyOrAlias,
              loadConfiguration
            ),
          async () => await llmEngine.listDownloadedLlmModels()
        )
      }
    )
  }

  /**
   * Implements {@link LlmModelInventory.listLlmModels} through the queue.
   *
   * @returns A promise resolving to snapshots in the order defined by
   * {@link LlmModelInventory.listLlmModels}, each loaded model with the
   * context length its instances are loaded with, and who loads them.
   * @throws If an inventory query fails or the queue rejects the operation.
   * @remarks The downloaded models, the loaded instances, and each loaded
   * model's context length are observed in one queued operation.
   */
  public async listLlmModels(): Promise<LlmListModelsApiResponse> {
    return await this.#llmEngineOperationQueue.handleLlmEngineOperationRequest(
      async ({ llmEngine, modelLoading }) =>
        Object.freeze({
          llms: await listLlmModels(
            async () => await llmEngine.listDownloadedLlmModels(),
            async () => await llmEngine.listLoadedLlmModelInstances(),
            async (model, texts) =>
              await llmEngine.findLlmContextMeasurement(model, texts)
          ),
          modelLoading
        })
    )
  }

  /**
   * Lists the downloaded models through the queue, without their loaded
   * state.
   *
   * @returns A promise resolving to the engine's frozen snapshots, in the
   * order the engine observed them.
   * @throws If the query fails, or the queue rejects the operation: the
   * service-busy failure when it is full, the runtime-unavailable failure
   * when no runtime is connected or it stopped answering, and
   * `The LLM runtime is closed.` after cleanup begins.
   * @remarks One engine query: no loaded instance is listed or measured, so
   * a reader that needs only what each model can do, such as whether it sees
   * images, pays for nothing else.
   */
  public async listDownloadedLlmModels(): Promise<
    readonly DownloadedLlmModel[]
  > {
    return await this.#llmEngineOperationQueue.handleLlmEngineOperationRequest(
      async ({ llmEngine }) => await llmEngine.listDownloadedLlmModels()
    )
  }

  /**
   * Implements {@link LlmModelStopper.stopLlmModelsByKey} through the queue.
   *
   * @param modelKey - Canonical model key shared by the instances to stop.
   * @returns A promise resolving to the immutable outcome from a fresh reconciliation snapshot.
   * @throws If the queue rejects the operation; runtime-operation failures are
   * represented in the returned outcome.
   * @throws The provider-loads-models refusal when the connected provider
   * loads its own models.
   */
  public async stopLlmModelsByKey(
    modelKey: string
  ): Promise<StopLlmModelsByKeyOutcome> {
    return await this.#llmEngineOperationQueue.handleLlmEngineOperationRequest(
      async (connectedLlmEngine) => {
        if (connectedLlmEngine.modelLoading === "provider") {
          throw createLlmProviderLoadsModelsError()
        }
        const { llmEngine, llmModelInstanceController } = connectedLlmEngine
        return await stopLlmModelsByKey(
          modelKey,
          async () => await llmEngine.listLoadedLlmModelInstances(),
          async (identifier) =>
            await llmModelInstanceController.stopLoadedLlmModelInstance(
              identifier
            )
        )
      }
    )
  }

  /**
   * Measures texts with the tokenizer of a loaded model, or estimates them
   * where the engine exposes no tokenizer, through the queue.
   *
   * @param model - Model selection as a chat request names it.
   * @param texts - Texts to count, each on its own.
   * @returns A promise resolving to the measurement
   * {@link LlmEngine.findLlmContextMeasurement} defines, or to undefined when no
   * loaded instance matches the selection.
   * @throws If the measurement fails, or the queue rejects the operation: the
   * service-busy failure when it is full, the runtime-unavailable failure
   * when no runtime is connected or it stopped answering, and
   * `The LLM runtime is closed.` after cleanup begins.
   * @remarks The measurement waits behind earlier accepted model operations,
   * including a load in progress.
   */
  public async findLlmContextMeasurement(
    model: string,
    texts: readonly string[]
  ): Promise<LlmContextMeasurement | undefined> {
    return await this.#llmEngineOperationQueue.handleLlmEngineOperationRequest(
      async ({ llmEngine }) =>
        await llmEngine.findLlmContextMeasurement(model, texts)
    )
  }
}

/**
 * Lists downloaded LLMs annotated from the current loaded-instance snapshot.
 *
 * @param listDownloadedLlmModels - Query for normalized immutable runtime metadata.
 * @param listLoadedLlmModelInstances - Query for immutable loaded-instance records.
 * @param findLlmContextMeasurement - Query for the context length a loaded
 * model is loaded with.
 * @returns A promise resolving to a transitively immutable, newly owned model
 * inventory in which each loaded model carries the context length that
 * {@link LlmEngine.findLlmContextMeasurement} reports for its key, the window a
 * chat request to it is measured against; a model whose instances were gone
 * by the time they were measured carries none.
 * @throws If an inventory query or a context length query fails.
 */
async function listLlmModels(
  listDownloadedLlmModels: LlmEngine["listDownloadedLlmModels"],
  listLoadedLlmModelInstances: ListLoadedLlmModelInstances,
  findLlmContextMeasurement: LlmEngine["findLlmContextMeasurement"]
): Promise<readonly LlmInfo[]> {
  const downloadedLlmModels = await listDownloadedLlmModels()
  const loadedLlmModelInstances = await listLoadedLlmModelInstances()
  const loadedModelKeys = new Set(
    loadedLlmModelInstances.map(({ modelKey }) => modelKey)
  )
  const loadedContextLengths = await listLoadedContextLengths(
    new Set(
      downloadedLlmModels
        .map(({ modelKey }) => modelKey)
        .filter((modelKey) => loadedModelKeys.has(modelKey))
    ),
    findLlmContextMeasurement
  )
  const llmModels = downloadedLlmModels
    .map((downloadedLlmModel) =>
      createLlmInfoSnapshot(
        downloadedLlmModel,
        buildLlmLoadedState(
          loadedModelKeys.has(downloadedLlmModel.modelKey),
          loadedContextLengths.get(downloadedLlmModel.modelKey)
        )
      )
    )
    .toSorted(calculateLlmInfoOrder)

  return Object.freeze(llmModels)
}

/**
 * Lists the context length each loaded model is loaded with.
 *
 * @param modelKeys - Canonical keys of the loaded models to measure.
 * @param findLlmContextMeasurement - Measurement query of the engine.
 * @returns A promise resolving, once every measurement has settled, to the
 * smallest context length among each model's loaded instances, by model key;
 * a key whose instances are no longer loaded has no entry.
 * @throws If a measurement fails; no later key is measured.
 * @remarks Each key is measured without text, so no tokenizer is asked. The
 * keys are measured one after another, because the LLM runtime admits one
 * operation at a time and refuses one that overlaps it.
 */
async function listLoadedContextLengths(
  modelKeys: ReadonlySet<string>,
  findLlmContextMeasurement: LlmEngine["findLlmContextMeasurement"]
): Promise<ReadonlyMap<string, number>> {
  const contextLengths = new Map<string, number>()
  for (const modelKey of modelKeys) {
    const measurement = await findLlmContextMeasurement(modelKey, [])
    if (measurement !== undefined)
      contextLengths.set(modelKey, measurement.contextLength)
  }
  return contextLengths
}

/**
 * Loads a model and resolves its canonical downloaded-model metadata.
 *
 * @param loadSelectedLlmModel - Command that loads the requested selection with
 * its load settings and returns the loaded model's validated identity.
 * @param listDownloadedLlmModels - Query for normalized immutable runtime metadata.
 * @returns A promise resolving to a validated immutable loaded-model snapshot.
 * @throws If loading or inventory fails, metadata is invalid, or the canonical
 * model is absent from downloaded inventory.
 */
async function loadRuntimeLlmModel(
  loadSelectedLlmModel: () => Promise<LoadedLlmModelInstance>,
  listDownloadedLlmModels: LlmEngine["listDownloadedLlmModels"]
): Promise<LlmLoadModelApiResponse> {
  const loadedModelInstance = await loadSelectedLlmModel()
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
    createLlmInfoSnapshot(downloadedLlmModel, LOADED_WITHOUT_CONTEXT_LENGTH)
  )
}

/**
 * Builds the loaded state of one downloaded model.
 *
 * @param isLoaded - Whether a loaded-instance snapshot contains its key.
 * @param loadedContextLength - Context length its instances are loaded with,
 * or undefined when it was not measured.
 * @returns Not loaded; or loaded, with the context length when one was
 * measured.
 */
function buildLlmLoadedState(
  isLoaded: boolean,
  loadedContextLength: number | undefined
): LlmLoadedState {
  if (!isLoaded) return NOT_LOADED
  return loadedContextLength === undefined
    ? LOADED_WITHOUT_CONTEXT_LENGTH
    : Object.freeze({ loaded: true, loadedContextLength })
}

/**
 * Adds application loaded state to normalized runtime metadata.
 *
 * @param downloadedLlmModel - Trusted immutable metadata returned by the runtime.
 * @param loadedState - Whether a loaded-instance snapshot contains this model
 * key, with the context length its instances are loaded with when known.
 * @returns A newly owned transitively immutable protocol snapshot.
 * @throws If the resulting application response does not satisfy its schema.
 */
function createLlmInfoSnapshot(
  downloadedLlmModel: DownloadedLlmModel,
  loadedState: LlmLoadedState
): LlmInfo {
  return llmInfoSchema.parse({ ...downloadedLlmModel, ...loadedState })
}

/**
 * Calculates deterministic ascending order for model inventory snapshots.
 *
 * @param left - First model snapshot to compare.
 * @param right - Second model snapshot to compare.
 * @returns A negative value when `left` precedes `right`, a positive value when
 * `right` precedes `left`, and zero when their keys and paths are equal. A
 * model without a path sorts before one with a path under the same key.
 */
function calculateLlmInfoOrder(left: LlmInfo, right: LlmInfo): number {
  if (left.modelKey < right.modelKey) {
    return -1
  }
  if (left.modelKey > right.modelKey) {
    return 1
  }
  const leftPath = left.path ?? ""
  const rightPath = right.path ?? ""
  if (leftPath < rightPath) {
    return -1
  }
  if (leftPath > rightPath) {
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
