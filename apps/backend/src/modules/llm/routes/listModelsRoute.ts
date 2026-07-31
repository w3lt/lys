import { llmListModelsApi, LlmListModelsApiRoute } from "@lys/protocol"
import { FastifyInstance } from "fastify"
import * as z from "zod"

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
