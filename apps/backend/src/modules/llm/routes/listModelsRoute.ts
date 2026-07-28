import { FastifyInstance } from "fastify"
import { LMStudioClient } from "@lmstudio/sdk"
import { apiLlmListModelsRoute, LlmListModelsApiResponse } from "@lys/protocol"

export default async function registerLlmListModelsRoute(app: FastifyInstance) {
  app.get(apiLlmListModelsRoute, listLlmApiHandler)
}

async function listLlmApiHandler(): Promise<LlmListModelsApiResponse> {
  const lmsClient = new LMStudioClient()

  const downloadedModels = await lmsClient.system.listDownloadedModels("llm")
  const loadedModels = await lmsClient.llm.listLoaded()

  const loadedKeys = new Set(loadedModels.map((llm) => llm.modelKey))

  return {
    llms: downloadedModels.map((llm) => ({
      ...llm,
      loaded: loadedKeys.has(llm.modelKey)
    }))
  }
}
