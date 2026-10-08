import type { LLMInfo } from "@lmstudio/sdk"

/** Constructor options the backend passes to the SDK client. */
type FakeLmStudioClientOptions = Readonly<{
  /** WebSocket endpoint of the LM Studio server. */
  baseUrl?: string
}>

/** Loaded-model handle fields exposed by the fake engine. */
export type FakeLoadedLlmHandle = Readonly<{
  /** Canonical key of the loaded model. */
  modelKey: string
  /** Instance identifier accepted by `llm.unload`. */
  identifier: string
}>

/** Downloaded and loaded models of the fake engine, replaced as one value. */
export type FakeLmStudioInventory = Readonly<{
  /** Vendor records returned by `system.listDownloadedModels("llm")`. */
  downloadedModels: readonly LLMInfo[]
  /** Handles returned by `llm.listLoaded()`, in load order. */
  loadedModels: readonly FakeLoadedLlmHandle[]
}>

/** Replaceable engine behavior reached through every fake SDK client. */
export type FakeLmStudioOperations = Readonly<{
  /** Runs while a client is constructed; throwing fails construction. */
  constructClient: (options: FakeLmStudioClientOptions) => void
  /** Answers the SDK readiness query. */
  getLMStudioVersion: () => Promise<{ version: string; build: number }>
  /** Lists downloaded vendor model records for one domain. */
  listDownloadedModels: (domain: string) => Promise<readonly unknown[]>
  /** Lists loaded model handles. */
  listLoaded: () => Promise<readonly unknown[]>
  /** Loads one model and resolves to its handle. */
  load: (modelKey: string) => Promise<unknown>
  /** Unloads one instance by identifier. */
  unload: (identifier: string) => Promise<void>
  /** Releases the resources of one client. */
  disposeClient: () => Promise<void>
}>

/** SDK `client.system` members the backend adapter uses. */
type FakeLmStudioSystemNamespace = Pick<
  FakeLmStudioOperations,
  "getLMStudioVersion" | "listDownloadedModels"
>

/** SDK `client.llm` members the backend adapter uses. */
type FakeLmStudioLlmNamespace = Pick<
  FakeLmStudioOperations,
  "listLoaded" | "load" | "unload"
>

/** Inventory of an engine with no downloaded or loaded model. */
const EMPTY_LM_STUDIO_INVENTORY: FakeLmStudioInventory = Object.freeze({
  downloadedModels: Object.freeze([]),
  loadedModels: Object.freeze([])
})

/**
 * Owns the model inventory and operation behavior that stand in for the
 * external LM Studio server, so that every fake SDK client in one test file
 * reaches the same in-memory engine.
 *
 * @remarks Replaces the external LM Studio server for unit tests that install
 * `vi.mock("@lmstudio/sdk", () => import("../support/lmStudioSdkFake"))`.
 * Default operations keep the inventory in memory: `load` accepts only an
 * exact downloaded key and adds a handle whose identifier is the key, suffixed
 * `:<n>` for later instances; `unload` rejects an unknown identifier. Client
 * construction and disposal have no default effect, so a case that observes
 * them replaces those operations with spies. Invariant: the inventory, frozen
 * together with every record and handle it holds, and the operations are each
 * one complete frozen value owned by the engine; every change replaces the
 * whole value, so no reader observes a partial update. Each case must call
 * {@link FakeLmStudioEngine.reset} before arranging the engine. Concurrency
 * model: single-owner. Vitest gives each test file its own module instance and
 * runs that file's cases one at a time, and every read and replacement of the
 * engine's state is synchronous on that file's event loop.
 */
class FakeLmStudioEngine {
  /** Current inventory, read and replaced by the default operations. */
  #inventory: FakeLmStudioInventory = EMPTY_LM_STUDIO_INVENTORY
  /** Current behavior reached through every fake client. */
  #operations: FakeLmStudioOperations = this.#createDefaultOperations()

  /** Restores an empty inventory and the default operations. */
  reset(): void {
    this.#inventory = EMPTY_LM_STUDIO_INVENTORY
    this.#operations = this.#createDefaultOperations()
  }

  /**
   * Downloaded and loaded models the default operations serve.
   *
   * @returns The current inventory, frozen together with every record and
   * handle it holds.
   */
  get inventory(): FakeLmStudioInventory {
    return this.#inventory
  }

  /**
   * Replaces the inventory a case arranges.
   *
   * @param inventory - Complete inventory. The engine retains frozen copies of
   * both lists and of every record and handle in them, so later changes to the
   * case's values do not reach the engine.
   */
  set inventory(inventory: FakeLmStudioInventory) {
    this.#inventory = Object.freeze({
      downloadedModels: Object.freeze(
        inventory.downloadedModels.map(buildOwnedLlmRecord)
      ),
      loadedModels: Object.freeze(
        inventory.loadedModels.map(buildOwnedLoadedHandle)
      )
    })
  }

  /**
   * Behavior every fake client delegates to.
   *
   * @returns The current frozen operations. A case replaces one operation by
   * assigning a copy that overrides it.
   */
  get operations(): FakeLmStudioOperations {
    return this.#operations
  }

  /**
   * Replaces the behavior a case arranges, to inject timing or failure.
   *
   * @param operations - Complete operations. The engine retains a frozen copy;
   * clients reach the new behavior on their next call.
   */
  set operations(operations: FakeLmStudioOperations) {
    this.#operations = Object.freeze({ ...operations })
  }

  /**
   * Creates the in-memory behavior of an available engine.
   *
   * @returns Frozen operations backed by this engine's inventory.
   */
  #createDefaultOperations(): FakeLmStudioOperations {
    return Object.freeze({
      constructClient: () => undefined,
      getLMStudioVersion: () =>
        Promise.resolve({ version: "0.3.30", build: 1 }),
      listDownloadedModels: (domain: string) =>
        Promise.resolve(this.#listDownloadedModels(domain)),
      listLoaded: () => Promise.resolve([...this.#inventory.loadedModels]),
      load: (modelKey: string) => Promise.resolve(this.#loadModel(modelKey)),
      unload: (identifier: string) =>
        new Promise<void>((resolve) => {
          this.#stopLoadedModelInstance(identifier)
          resolve()
        }),
      disposeClient: () => Promise.resolve()
    })
  }

  /**
   * Lists the downloaded vendor records for one model domain.
   *
   * @param domain - SDK model domain; the engine serves only `llm`.
   * @returns A new array holding the engine's frozen records.
   * @throws If the domain is not `llm`.
   */
  #listDownloadedModels(domain: string): readonly LLMInfo[] {
    if (domain !== "llm") {
      throw new Error(`Unsupported model domain "${domain}".`)
    }
    return [...this.#inventory.downloadedModels]
  }

  /**
   * Adds a loaded instance for one downloaded model key.
   *
   * @param modelKey - Exact downloaded model key.
   * @returns The new instance handle.
   * @throws If the key is not downloaded.
   */
  #loadModel(modelKey: string): FakeLoadedLlmHandle {
    const { downloadedModels, loadedModels } = this.#inventory
    if (!downloadedModels.some((model) => model.modelKey === modelKey)) {
      throw new Error(`Model "${modelKey}" is not downloaded.`)
    }
    const instanceCount = loadedModels.filter(
      (model) => model.modelKey === modelKey
    ).length
    const handle = Object.freeze({
      modelKey,
      identifier:
        instanceCount === 0 ? modelKey : `${modelKey}:${instanceCount + 1}`
    })
    this.#inventory = Object.freeze({
      downloadedModels,
      loadedModels: Object.freeze([...loadedModels, handle])
    })
    return handle
  }

  /**
   * Stops one loaded instance, removing it from the inventory.
   *
   * @param identifier - Identifier of a currently loaded instance.
   * @throws If no loaded instance has the identifier.
   */
  #stopLoadedModelInstance(identifier: string): void {
    const { downloadedModels, loadedModels } = this.#inventory
    const index = loadedModels.findIndex(
      (model) => model.identifier === identifier
    )
    if (index === -1) {
      throw new Error(`No loaded instance "${identifier}".`)
    }
    this.#inventory = Object.freeze({
      downloadedModels,
      loadedModels: Object.freeze(loadedModels.toSpliced(index, 1))
    })
  }
}

/**
 * Builds the engine's own frozen copy of one downloaded vendor record.
 *
 * @param record - Record supplied by a case; it is not changed.
 * @returns A frozen record with the same fields. Its quantization, the only
 * nested value an `LLMInfo` record holds, is copied and frozen as well.
 */
function buildOwnedLlmRecord(record: LLMInfo): LLMInfo {
  const { quantization } = record
  if (quantization === undefined) {
    return Object.freeze({ ...record })
  }
  return Object.freeze({
    ...record,
    quantization: Object.freeze({
      name: quantization.name,
      bits: quantization.bits
    })
  })
}

/**
 * Builds the engine's own frozen copy of one loaded handle.
 *
 * @param handle - Handle supplied by a case; it is not changed.
 * @returns A frozen handle with the same key and identifier.
 */
function buildOwnedLoadedHandle(
  handle: FakeLoadedLlmHandle
): FakeLoadedLlmHandle {
  return Object.freeze({
    modelKey: handle.modelKey,
    identifier: handle.identifier
  })
}

/** Engine controlling every fake client constructed in the current test file. */
export const fakeLmStudio = new FakeLmStudioEngine()

/**
 * Stand-in for the SDK client class that forwards every call to
 * {@link fakeLmStudio}, so the adapter under test reaches the in-memory engine.
 *
 * @remarks Provides only the members the backend adapter uses. The SDK fixes
 * the constructor signature, so the client reaches the module-level engine
 * instead of an injected one. A rejected `constructClient` throws from the
 * constructor, so the adapter receives no client to dispose. Invariant: the
 * client owns no mutable state; its two namespaces are frozen and read the
 * engine's current operations on every call. Concurrency model: single-owner,
 * on the event loop of the test file that owns {@link fakeLmStudio}; the client
 * adds no synchronization of its own.
 */
export class LMStudioClient {
  /** Frozen system namespace forwarding to the engine. */
  readonly #system: FakeLmStudioSystemNamespace = Object.freeze({
    getLMStudioVersion: async () =>
      await fakeLmStudio.operations.getLMStudioVersion(),
    listDownloadedModels: async (domain: string) =>
      await fakeLmStudio.operations.listDownloadedModels(domain)
  })
  /** Frozen LLM namespace forwarding to the engine. */
  readonly #llm: FakeLmStudioLlmNamespace = Object.freeze({
    listLoaded: async () => await fakeLmStudio.operations.listLoaded(),
    load: async (modelKey: string) =>
      await fakeLmStudio.operations.load(modelKey),
    unload: async (identifier: string) =>
      await fakeLmStudio.operations.unload(identifier)
  })

  /**
   * Runs the engine's construction behavior for the configured endpoint.
   *
   * @param options - Endpoint options passed by the adapter.
   * @throws Whatever the engine's `constructClient` operation throws.
   */
  constructor(options: FakeLmStudioClientOptions = {}) {
    fakeLmStudio.operations.constructClient(options)
  }

  /**
   * System namespace used for readiness and downloaded inventory.
   *
   * @returns The client's frozen system namespace.
   */
  get system(): FakeLmStudioSystemNamespace {
    return this.#system
  }

  /**
   * LLM namespace used for loaded inventory, loading, and unloading.
   *
   * @returns The client's frozen LLM namespace.
   */
  get llm(): FakeLmStudioLlmNamespace {
    return this.#llm
  }

  /**
   * Runs the engine's release behavior.
   *
   * @returns Settlement of the engine's `disposeClient` operation.
   */
  async [Symbol.asyncDispose](): Promise<void> {
    await fakeLmStudio.operations.disposeClient()
  }
}
