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

/** Replaceable engine behavior reached through every fake SDK client. */
export type FakeLmStudioOperations = {
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
}

/** Observation of one client constructed through the fake SDK. */
export type FakeLmStudioClientRecord = {
  /** Endpoint passed at construction. */
  readonly baseUrl: string | undefined
  /** Number of `Symbol.asyncDispose` calls received. */
  disposeCount: number
}

/**
 * In-memory LM Studio engine shared by every fake SDK client in one test file.
 *
 * @remarks Replaces the external LM Studio server for unit tests that install
 * `vi.mock("@lmstudio/sdk", () => import("../support/lmStudioSdkFake"))`.
 * Default operations keep downloaded and loaded models in memory: `load`
 * accepts only an exact downloaded key and adds a handle whose identifier is
 * the key, suffixed `:<n>` for later instances; `unload` rejects an unknown
 * identifier. Vitest isolates module state per test file, and cases within a
 * file run sequentially; each case must call {@link FakeLmStudioEngine.reset}
 * before arranging the engine.
 */
class FakeLmStudioEngine {
  /** Vendor records returned by `system.listDownloadedModels("llm")`. */
  downloadedModels: LLMInfo[] = []
  /** Handles returned by `llm.listLoaded()`, in load order. */
  loadedModels: FakeLoadedLlmHandle[] = []
  /** Clients constructed since the last reset, in construction order. */
  readonly clients: FakeLmStudioClientRecord[] = []
  /** Current behavior; a case replaces one entry to inject timing or failure. */
  operations: FakeLmStudioOperations = this.#createDefaultOperations()

  /** Restores an empty, available engine and forgets constructed clients. */
  reset(): void {
    this.downloadedModels = []
    this.loadedModels = []
    this.clients.length = 0
    this.operations = this.#createDefaultOperations()
  }

  /**
   * Creates the in-memory behavior of an available engine.
   *
   * @returns Operations backed by this engine's model collections.
   */
  #createDefaultOperations(): FakeLmStudioOperations {
    return {
      constructClient: () => undefined,
      getLMStudioVersion: async () => ({ version: "0.3.30", build: 1 }),
      listDownloadedModels: async (domain) => {
        if (domain !== "llm") {
          throw new Error(`Unsupported model domain "${domain}".`)
        }
        return [...this.downloadedModels]
      },
      listLoaded: async () => [...this.loadedModels],
      load: async (modelKey) => this.#loadModel(modelKey),
      unload: async (identifier) => this.#unloadModel(identifier),
      disposeClient: async () => undefined
    }
  }

  /**
   * Adds a loaded instance for one downloaded model key.
   *
   * @param modelKey - Exact downloaded model key.
   * @returns The new instance handle.
   * @throws If the key is not downloaded.
   */
  #loadModel(modelKey: string): FakeLoadedLlmHandle {
    if (!this.downloadedModels.some((model) => model.modelKey === modelKey)) {
      throw new Error(`Model "${modelKey}" is not downloaded.`)
    }
    const instanceCount = this.loadedModels.filter(
      (model) => model.modelKey === modelKey
    ).length
    const handle = Object.freeze({
      modelKey,
      identifier:
        instanceCount === 0 ? modelKey : `${modelKey}:${instanceCount + 1}`
    })
    this.loadedModels.push(handle)
    return handle
  }

  /**
   * Removes one loaded instance.
   *
   * @param identifier - Identifier of a currently loaded instance.
   * @throws If no loaded instance has the identifier.
   */
  #unloadModel(identifier: string): void {
    const index = this.loadedModels.findIndex(
      (model) => model.identifier === identifier
    )
    if (index === -1) {
      throw new Error(`No loaded instance "${identifier}".`)
    }
    this.loadedModels.splice(index, 1)
  }
}

/** Engine controlling every fake client constructed in the current test file. */
export const fakeLmStudio = new FakeLmStudioEngine()

/**
 * Stand-in for the SDK client class, delegating to {@link fakeLmStudio}.
 *
 * @remarks Provides only the members the backend adapter uses. Construction
 * is recorded after `constructClient` succeeds, so a rejected construction
 * leaves no client to dispose.
 */
export class LMStudioClient {
  /** System namespace used for readiness and downloaded inventory. */
  readonly system = Object.freeze({
    getLMStudioVersion: async () =>
      await fakeLmStudio.operations.getLMStudioVersion(),
    listDownloadedModels: async (domain: string) =>
      await fakeLmStudio.operations.listDownloadedModels(domain)
  })
  /** LLM namespace used for loaded inventory, loading, and unloading. */
  readonly llm = Object.freeze({
    listLoaded: async () => await fakeLmStudio.operations.listLoaded(),
    load: async (modelKey: string) =>
      await fakeLmStudio.operations.load(modelKey),
    unload: async (identifier: string) =>
      await fakeLmStudio.operations.unload(identifier)
  })
  /** Observation record shared with {@link fakeLmStudio}. */
  readonly #record: FakeLmStudioClientRecord

  /**
   * Records a client for the configured endpoint.
   *
   * @param options - Endpoint options passed by the adapter.
   * @throws Whatever the engine's `constructClient` operation throws.
   */
  constructor(options: FakeLmStudioClientOptions = {}) {
    fakeLmStudio.operations.constructClient(options)
    this.#record = { baseUrl: options.baseUrl, disposeCount: 0 }
    fakeLmStudio.clients.push(this.#record)
  }

  /**
   * Records a disposal request and runs the engine's release behavior.
   *
   * @returns Settlement of the engine's `disposeClient` operation.
   */
  async [Symbol.asyncDispose](): Promise<void> {
    this.#record.disposeCount += 1
    await fakeLmStudio.operations.disposeClient()
  }
}
