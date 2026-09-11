import { llmLoadModelApi, type LlmLoadModelApiRoute } from "@lys/protocol"
import type { FastifyInstance, FastifyRequest } from "fastify"
import * as z from "zod"
import type { LlmModelLoader } from "../llmModelCapabilities"
import handleLlmServiceRequestFailure from "./handleLlmServiceRequestFailure"

/**
 * Adds the LLM load endpoint with protocol validation to a Fastify application.
 *
 * @param app - Application instance that receives the LLM load route.
 * @returns A promise that resolves after route registration completes.
 * @throws If Fastify cannot register the route.
 * @remarks Refused queue admission returns service-busy Problem Details.
 * Other service failures remain owned by Fastify's parent error boundary.
 */
export default async function updateFastifyWithLlmModelLoadRoute(
  app: FastifyInstance
): Promise<void> {
  const llmModelLoader: LlmModelLoader = app.llmService

  app.route<LlmLoadModelApiRoute>({
    method: llmLoadModelApi.method,
    url: llmLoadModelApi.path,
    schema: {
      body: llmLoadModelApi.body,
      response: {
        200: z.toJSONSchema(llmLoadModelApi.responses[200], {
          target: "draft-7"
        }),
        503: z.toJSONSchema(llmLoadModelApi.responses[503], {
          target: "draft-7"
        })
      }
    },
    validatorCompiler: () => (data) => {
      const result = llmLoadModelApi.body.safeParse(data)
      return result.success ? { value: result.data } : { error: result.error }
    },
    errorHandler: handleLlmServiceRequestFailure,
    handler: async (request) =>
      await handleLlmModelLoadRequest(request, llmModelLoader)
  })
}

/**
 * Delegates one validated model load to the application-owned LLM service.
 *
 * @param request - Validated Fastify request containing the model identifier or alias to load.
 * @param llmModelLoader - Application capability that performs the model load.
 * @returns A promise resolving to validated metadata for the canonical loaded model.
 * @throws If the service cannot load or enumerate models, the canonical model
 * is absent from inventory, admission is refused, or application cleanup has
 * begun. The route boundary translates only recognized admission rejection.
 */
async function handleLlmModelLoadRequest(
  request: FastifyRequest<LlmLoadModelApiRoute>,
  llmModelLoader: LlmModelLoader
): Promise<LlmLoadModelApiRoute["Reply"][200]> {
  return await llmModelLoader.loadLlmModel(request.body.modelId)
}
