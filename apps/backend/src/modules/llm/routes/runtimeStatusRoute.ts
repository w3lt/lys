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
 * @throws If Fastify cannot register the route. The failure rejects the
 * promise rather than escaping the call synchronously.
 * @remarks The handler reads the in-memory status without contacting LM
 * Studio or entering the model-operation queue.
 */
export default function updateFastifyWithLlmRuntimeStatusRoute(
  app: FastifyInstance
): Promise<void> {
  return new Promise((resolve) => {
    registerLlmRuntimeStatusRoute(app)
    resolve()
  })
}

/**
 * Registers the LLM runtime status endpoint.
 *
 * @param app - Application instance that receives the route.
 * @throws If Fastify cannot register the route.
 */
function registerLlmRuntimeStatusRoute(app: FastifyInstance): void {
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
    handler: function () {
      return Object.freeze({
        status: llmRuntimeConnectionObserver.llmRuntimeConnectionStatus
      })
    }
  })
}
