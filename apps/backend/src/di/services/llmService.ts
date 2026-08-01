import type { BaseLoadModelOpts, LLMLoadModelConfig } from "@lmstudio/sdk"
import { LMStudioClient } from "@lmstudio/sdk"
import type { LlmInfo } from "@lys/protocol"

/** Settings used to create an application-scoped LM Studio client. */
export type LlmServiceCreationOptions = {
  /** WebSocket base URL of the LM Studio server. */
  lmsBaseUrl: string
}

/** Application-scoped LM Studio lifecycle and inventory adapter. */
export default class LlmService {
  /** Owned LM Studio SDK client used for model lifecycle and inventory operations. */
  #lmsClient: LMStudioClient

  /**
   * Creates an LM Studio adapter for the configured server.
   *
   * @param options - WebSocket base URL used to create the client.
   */
  constructor({ lmsBaseUrl }: LlmServiceCreationOptions) {
    this.#lmsClient = new LMStudioClient({
      baseUrl: lmsBaseUrl
    })
  }

  /**
   * Loads a model into the LM Studio runtime.
   *
   * @param modelKey - Canonical LM Studio key of the model to load.
   * @param options - Optional LM Studio load and runtime settings.
   * @returns A promise that resolves to the loaded-model result after LM Studio loads the requested model.
   * @throws If LM Studio cannot resolve or load the requested model.
   */
  public async loadModel(
    modelKey: string,
    options?: BaseLoadModelOpts<LLMLoadModelConfig>
  ) {
    return await this.#lmsClient.llm.load(modelKey, options)
  }

  /**
   * Unloads a model from the LM Studio runtime.
   *
   * @param modelKey - Canonical LM Studio key of the model to unload.
   * @returns A promise that resolves to the LM Studio SDK result after the requested model is unloaded.
   * @throws If LM Studio cannot unload the requested model.
   */
  public async unloadModel(modelKey: string) {
    return await this.#lmsClient.llm.unload(modelKey)
  }

  /**
   * Lists downloaded language models enriched with their current loaded state.
   *
   * @returns A promise that resolves to the downloaded-model inventory annotated with loaded state after both inventories are retrieved.
   * @throws If LM Studio cannot retrieve downloaded or loaded model inventory.
   */
  public async listModel(): Promise<LlmInfo[]> {
    const downloadedModels =
      await this.#lmsClient.system.listDownloadedModels("llm")
    const loadedModels = await this.#lmsClient.llm.listLoaded()

    const loadedKeys = new Set(loadedModels.map((llm) => llm.modelKey))

    return downloadedModels.map((llm) => ({
      ...llm,
      loaded: loadedKeys.has(llm.modelKey)
    }))
  }

  /**
   * Delegates asynchronous disposal to the owned LM Studio SDK client.
   *
   * @returns A promise that resolves after the owned LM Studio SDK client completes disposal.
   * @throws If the LM Studio client cannot complete asynchronous disposal.
   */
  public async [Symbol.asyncDispose]() {
    await this.#lmsClient[Symbol.asyncDispose]()
  }
}
