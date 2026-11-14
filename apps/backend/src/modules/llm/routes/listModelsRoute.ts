import { llmListModelsApi, type LlmListModelsApiRoute } from "@lys/protocol"
import type { FastifyInstance } from "fastify"
import * as z from "zod"
import type { LlmModelInventory } from "../llmModelCapabilities"
import handleLlmServiceRequestFailure from "./handleLlmServiceRequestFailure"
import { buildLlmRouteValidatorCompiler } from "./llmRouteValidation"

/**
 * Adds the protocol-defined LLM inventory endpoint to a Fastify application.
 *
 * The registrar mutates `app` by installing the protocol GET path. The handler
 * reads the application-owned LLM service of the provider the path names and
 * serializes that provider's downloaded models enriched with their loaded
 * state, and who loads them.
 *
 * @param app - Application instance that receives the LLM inventory route.
 * @returns A promise that resolves after route registration completes.
 * @throws If Fastify cannot register the route. The failure rejects the
 * promise rather than escaping the call synchronously.
 * @remarks A path naming no known provider is refused with 400 before the
 * handler runs. Refused queue admission returns service-busy Problem
 * Details, and a missing or lost LLM runtime connection of the provider
 * returns runtime-unavailable Problem Details. Other service failures remain
 * owned by Fastify's parent error boundary.
 */
export default function updateFastifyWithLlmListModelsRoute(
  app: FastifyInstance
): Promise<void> {
  return new Promise((resolve) => {
    registerLlmListModelsRoute(app)
    resolve()
  })
}

/**
 * Registers the LLM inventory endpoint.
 *
 * @param app - Application instance that receives the route.
 * @throws If Fastify cannot register the route.
 */
function registerLlmListModelsRoute(app: FastifyInstance): void {
  const llmProviderServices = app.llmProviderServices

  app.route<LlmListModelsApiRoute>({
    method: llmListModelsApi.method,
    url: llmListModelsApi.path,
    schema: {
      params: z.toJSONSchema(llmListModelsApi.params, { target: "draft-7" }),
      response: {
        200: z.toJSONSchema(llmListModelsApi.responses[200], {
          target: "draft-7"
        }),
        503: z.toJSONSchema(llmListModelsApi.responses[503], {
          target: "draft-7"
        })
      }
    },
    validatorCompiler: buildLlmRouteValidatorCompiler({
      params: llmListModelsApi.params
    }),
    errorHandler: handleLlmServiceRequestFailure,
    handler: async function (request) {
      const llmModelInventory: LlmModelInventory =
        llmProviderServices[request.params.provider].llmService
      return await llmModelInventory.listLlmModels()
    }
  })
}
