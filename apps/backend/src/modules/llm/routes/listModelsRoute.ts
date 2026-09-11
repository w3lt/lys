import { llmListModelsApi, type LlmListModelsApiRoute } from "@lys/protocol"
import type { FastifyInstance } from "fastify"
import * as z from "zod"
import type { LlmModelInventory } from "../llmModelCapabilities"
import handleLlmServiceRequestFailure from "./handleLlmServiceRequestFailure"

/**
 * Adds the protocol-defined LLM inventory endpoint to a Fastify application.
 *
 * The registrar mutates `app` by installing the protocol GET path. The handler
 * reads the application-owned LLM service and serializes downloaded models
 * enriched with their loaded state.
 *
 * @param app - Application instance that receives the LLM inventory route.
 * @returns A promise that resolves after route registration completes.
 * @throws If Fastify cannot register the route.
 * @remarks Refused queue admission returns service-busy Problem Details.
 * Other service failures remain owned by Fastify's parent error boundary.
 */
export default async function updateFastifyWithLlmListModelsRoute(
  app: FastifyInstance
): Promise<void> {
  const llmModelInventory: LlmModelInventory = app.llmService

  app.route<LlmListModelsApiRoute>({
    method: llmListModelsApi.method,
    url: llmListModelsApi.path,
    schema: {
      response: {
        200: z.toJSONSchema(llmListModelsApi.responses[200], {
          target: "draft-7"
        }),
        503: z.toJSONSchema(llmListModelsApi.responses[503], {
          target: "draft-7"
        })
      }
    },
    errorHandler: handleLlmServiceRequestFailure,
    handler: async function () {
      const llms = await llmModelInventory.listLlmModels()
      return Object.freeze({
        llms
      })
    }
  })
}
