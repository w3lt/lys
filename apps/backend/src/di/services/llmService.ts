import {
  BaseLoadModelOpts,
  LLMLoadModelConfig,
  LMStudioClient
} from "@lmstudio/sdk"
import { LlmInfo } from "@lys/protocol"

export type LlmServiceCreationOptions = {
  lmsBaseUrl: string
}

export default class LlmService {
  #lmsClient: LMStudioClient

  constructor({ lmsBaseUrl }: LlmServiceCreationOptions) {
    this.#lmsClient = new LMStudioClient({
      baseUrl: lmsBaseUrl
    })
  }

  public async loadModel(
    modelKey: string,
    options?: BaseLoadModelOpts<LLMLoadModelConfig>
  ) {
    return await this.#lmsClient.llm.load(modelKey, options)
  }

  public async unloadModel(modelKey: string) {
    return await this.#lmsClient.llm.unload(modelKey)
  }

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

  public async [Symbol.asyncDispose]() {
    await this.#lmsClient[Symbol.asyncDispose]()
  }
}
