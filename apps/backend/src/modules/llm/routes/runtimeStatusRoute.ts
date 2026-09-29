import {
  llmRuntimeStatusApi,
  type LlmRuntimeStatusApiRoute
} from "@lys/protocol"
import type { FastifyInstance } from "fastify"
import * as z from "zod"
import type { LlmRuntimeConnectionObserver } from "../llmRuntimeCapabilities"

/**
 * Adds the protocol-defined LLM runtime status endpoint to a Fastify application.
 *
 * @param app - Application instance that receives the runtime-status route.
 * @returns A promise that resolves after route registration completes.
 * @throws If Fastify cannot register the route.
 * @remarks The handler reads the in-memory status without contacting LM
 * Studio or entering the model-operation queue.
 */
export default async function updateFastifyWithLlmRuntimeStatusRoute(
  app: FastifyInstance
): Promise<void> {
  const llmRuntimeConnectionObserver: LlmRuntimeConnectionObserver =
    app.llmRuntimeService

  app.route<LlmRuntimeStatusApiRoute>({
    method: llmRuntimeStatusApi.method,
    url: llmRuntimeStatusApi.path,
    schema: {
      response: {
        200: z.toJSONSchema(llmRuntimeStatusApi.responses[200], {
          target: "draft-7"
        })
      }
    },
    handler: async function () {
      return Object.freeze({
        status: llmRuntimeConnectionObserver.llmRuntimeConnectionStatus
      })
    }
  })
}
