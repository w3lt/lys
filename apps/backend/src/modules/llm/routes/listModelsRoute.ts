import { llmListModelsApi, type LlmListModelsApiRoute } from "@lys/protocol"
import type { FastifyInstance } from "fastify"
import * as z from "zod"

/**
 * Registers the protocol-defined LLM inventory endpoint on a Fastify application.
 *
 * The endpoint serializes downloaded models enriched with their loaded state.
 *
 * @param app - Application instance that receives the LLM inventory route.
 * @returns A promise that resolves after route registration completes.
 * @throws If Fastify cannot register the route.
 */
export default async function registerLlmListModelsRoute(app: FastifyInstance) {
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
    handler: async function () {
      const llms = await this.llmService.listModel()
      return {
        llms
      }
    }
  })
}
