import { llmLoadModelApi, LlmLoadModelApiRoute } from "@lys/protocol"
import { FastifyInstance, FastifyRequest } from "fastify"
import * as z from "zod"
import { LMStudioClient } from "@lmstudio/sdk"

export default async function registerLlmLoadModelRoute(app: FastifyInstance) {
  app.route<LlmLoadModelApiRoute>({
    method: llmLoadModelApi.method,
    url: llmLoadModelApi.path,
    schema: {
      body: llmLoadModelApi.body,
      response: {
        200: z.toJSONSchema(llmLoadModelApi.response, {
          target: "draft-7"
        })
      }
    },
    validatorCompiler: () => (data) => {
      const result = llmLoadModelApi.body.safeParse(data)
      return result.success ? { value: result.data } : { error: result.error }
    },
    handler: (request) => loadLlmApiHandler(request)
  })
}

async function loadLlmApiHandler(
  request: FastifyRequest<LlmLoadModelApiRoute>
): Promise<LlmLoadModelApiRoute["Reply"]> {
  const lmsClient = new LMStudioClient()
  const loadedModel = await lmsClient.llm.load(request.body.modelId)
  const downloadedModels = await lmsClient.system.listDownloadedModels("llm")
  const downloadedModel = downloadedModels.find(
    (model) => model.modelKey === loadedModel.modelKey
  )

  if (downloadedModel === undefined) {
    throw new Error(
      `Loaded model "${loadedModel.modelKey}" was not found in the downloaded LLM inventory`
    )
  }

  return {
    ...downloadedModel,
    loaded: true
  }
}
