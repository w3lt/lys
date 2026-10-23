import {
  llmInfoSchema,
  llmLoadModelApiResponseBodySchema,
  llmTestModelApiParamsSchema,
  type LlmInfo,
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
import type {
  DownloadedLlmModel,
  LlmContextMeasurement,
  LoadedLlmModelInstance
} from "./llmRuntimeTypes"
import {
  buildLysLlmInstanceIdentifier,
  createRandomLysInstanceSuffix,
  findLoadedLysLlmInstanceIdentifiers
} from "./lysLlmInstanceIdentifiers"
import type { LysLlmInstanceStore } from "./lysLlmInstanceStore"

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
  /**
   * Borrowed record of the instances Lys loaded, read and saved only inside
   * queued model operations.
   */
  readonly lysLlmInstanceStore: LysLlmInstanceStore
  /** Monotonic millisecond clock; defaults to the process performance clock. */
  readonly readMonotonicTimeMs?: () => number
  /**
   * Generator of the random part of each new instance identifier; defaults
   * to six lowercase hex digits from three random bytes.
   */
  readonly createLysInstanceSuffix?: () => string
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

  /** Borrowed record of the instances Lys loaded. */
  readonly #lysLlmInstanceStore: LysLlmInstanceStore

  /** Borrowed monotonic clock used only around admitted health queries. */
  readonly #readMonotonicTimeMs: () => number

  /** Generator of the random part of each new instance identifier. */
  readonly #createLysInstanceSuffix: () => string

  /**
   * Creates a ready service over a borrowed operation queue and record.
   *
   * @param options - Borrowed queue and record, with an optional monotonic
   * clock and suffix generator.
   */
  public constructor({
    llmEngineOperationQueue,
    lysLlmInstanceStore,
    readMonotonicTimeMs = readPerformanceNowMs,
    createLysInstanceSuffix = createRandomLysInstanceSuffix
  }: LlmServiceCreationOptions) {
    this.#llmEngineOperationQueue = llmEngineOperationQueue
    this.#lysLlmInstanceStore = lysLlmInstanceStore
    this.#readMonotonicTimeMs = readMonotonicTimeMs
    this.#createLysInstanceSuffix = createLysInstanceSuffix
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
   * @param loadConfiguration - Interface-defined load settings, passed to the
   * connected runtime unchanged.
   * @returns A promise resolving to a validated immutable model snapshot after
   * the runtime loads the model and its canonical key is found in inventory.
   * @throws If listing the loaded instances, reading or saving the record,
   * loading, or inventory fails, response validation fails, or the queue
   * rejects the operation.
   * @throws An `Error` whose message is the record's reason followed by
   * `No model was loaded, so the record is left as it is.` when the record
   * cannot be read; nothing is saved or loaded.
   * @throws An `Error` with the message `Loaded model "<canonical model key>"
   * was not found in the downloaded LLM inventory` if the canonical model is
   * absent from inventory after loading.
   * @remarks The instance's identifier, `<modelKeyOrAlias>@lys-<suffix>`, is
   * saved before the runtime loads, with the saved identifiers whose
   * instances are still loaded, so an instance the runtime loads is always
   * on the record. A failed load leaves its identifier saved until a later
   * load or unload finds its instance gone.
   */
  public async loadLlmModel(
    modelKeyOrAlias: string,
    loadConfiguration: ModelLoadConfiguration
  ): Promise<LlmLoadModelApiResponse> {
    return await this.#llmEngineOperationQueue.handleLlmEngineOperationRequest(
      async (llmEngine) => {
        const instanceIdentifier = buildLysLlmInstanceIdentifier(
          modelKeyOrAlias,
          this.#createLysInstanceSuffix()
        )
        await addLysLlmInstanceIdentifier(
          instanceIdentifier,
          async () => await llmEngine.listLoadedLlmModelInstances(),
          this.#lysLlmInstanceStore
        )
        return await loadRuntimeLlmModel(
          async () =>
            await llmEngine.loadLlmModel(
              modelKeyOrAlias,
              loadConfiguration,
              instanceIdentifier
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
   * context length its instances are loaded with.
   * @throws If an inventory query fails or the queue rejects the operation.
   * @remarks The downloaded models, the loaded instances, and each loaded
   * model's context length are observed in one queued operation.
   */
  public async listLlmModels(): Promise<readonly LlmInfo[]> {
    return await this.#llmEngineOperationQueue.handleLlmEngineOperationRequest(
      async (llmEngine) =>
        await listLlmModels(
          async () => await llmEngine.listDownloadedLlmModels(),
          async () => await llmEngine.listLoadedLlmModelInstances(),
          async (model, texts) =>
            await llmEngine.findLlmContextMeasurement(model, texts)
        )
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
      async (llmEngine) => await llmEngine.listDownloadedLlmModels()
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

  /**
   * Measures texts with the tokenizer of a loaded model, through the queue.
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
      async (llmEngine) =>
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
 * Saves a new identifier on the record, with the saved identifiers whose
 * instances are still loaded.
 *
 * @param instanceIdentifier - Identifier of the instance about to load.
 * @param listLoadedLlmModelInstances - Query for the instances loaded now.
 * @param lysLlmInstanceStore - Record of the instances Lys loaded.
 * @returns A promise resolving once the record holds the new identifier.
 * @throws If the query or the save fails; or, when the record cannot be
 * read, an `Error` with its reason, without saving, since replacing a
 * record that cannot be read would lose it.
 */
async function addLysLlmInstanceIdentifier(
  instanceIdentifier: string,
  listLoadedLlmModelInstances: ListLoadedLlmModelInstances,
  lysLlmInstanceStore: LysLlmInstanceStore
): Promise<void> {
  const loadedModelInstances = await listLoadedLlmModelInstances()
  const savedRecord = await lysLlmInstanceStore.readLysLlmInstanceIdentifiers()
  if (savedRecord.status === "unreadable") {
    throw new Error(
      `${savedRecord.message} No model was loaded, so the record is left as it is.`
    )
  }
  const keptIdentifiers = findLoadedLysLlmInstanceIdentifiers(
    savedRecord.instanceIdentifiers,
    loadedModelInstances
  )
  keptIdentifiers.add(instanceIdentifier)
  await lysLlmInstanceStore.saveLysLlmInstanceIdentifiers(keptIdentifiers)
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
