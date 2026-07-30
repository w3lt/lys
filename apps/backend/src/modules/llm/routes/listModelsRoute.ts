import { llmListModelsApi, LlmListModelsApiRoute } from "@lys/protocol"
import { FastifyInstance } from "fastify"
import * as z from "zod"
import { RegisterLlmRoutesOptions } from "./dependencies"
import { LMStudioClient } from "@lmstudio/sdk"

export default async function registerLlmListModelsRoute(
  app: FastifyInstance,
  options: RegisterLlmRoutesOptions
) {
  app.route<LlmListModelsApiRoute>({
    method: llmListModelsApi.method,
    url: llmListModelsApi.path,
    schema: {
      response: {
        200: z.toJSONSchema(llmListModelsApi.response, {
          target: "draft-7"
        })
      }
    },
    handler: () => listLlmApiHandler(options.createClient)
  })
}

async function listLlmApiHandler(
  createClient: () => LMStudioClient
): Promise<LlmListModelsApiRoute["Reply"]> {
  const lmsClient = createClient()

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
