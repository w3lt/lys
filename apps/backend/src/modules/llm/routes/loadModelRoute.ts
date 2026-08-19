import { llmLoadModelApi, type LlmLoadModelApiRoute } from "@lys/protocol"
import type { FastifyInstance, FastifyRequest } from "fastify"
import * as z from "zod"
import { LMStudioClient } from "@lmstudio/sdk"

/**
 * Registers the LLM load endpoint with protocol body validation and response serialization.
 *
 * The registrar mutates `app` by installing the protocol POST path. The
 * handler validates the request body before loading a model and returns the
 * matching downloaded inventory entry marked as loaded.
 *
 * @param app - Application instance that receives the LLM load route.
 * @returns A promise that resolves after route registration completes.
 * @throws If Fastify cannot register the route.
 * @remarks Invalid bodies are rejected by protocol validation. Model-loading,
 * inventory, and missing-canonical-model failures propagate from the handler to
 * Fastify's request error boundary.
 */
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

/**
 * Loads the requested LLM, then uses its canonical model key to find downloaded model metadata.
 *
 * @param request - Validated Fastify request containing the model identifier or alias that LM Studio resolves during loading.
 * @returns A promise that resolves to downloaded model metadata marked as loaded after the canonical model key is found in inventory.
 * @throws If LM Studio cannot load or enumerate models, or if the loaded model is absent from the downloaded inventory.
 */
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
