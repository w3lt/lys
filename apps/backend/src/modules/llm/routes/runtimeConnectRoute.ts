import {
  llmRuntimeConnectApi,
  type LlmRuntimeConnectApiRoute
} from "@lys/protocol"
import type { FastifyInstance } from "fastify"
import * as z from "zod"
import type { LlmRuntimeConnector } from "../llmRuntimeCapabilities"
import handleLlmServiceRequestFailure from "./handleLlmServiceRequestFailure"

/**
 * Adds the protocol-defined LLM runtime connect endpoint to a Fastify application.
 *
 * @param app - Application instance that receives the runtime-connect route.
 * @returns A promise that resolves after route registration completes.
 * @throws If Fastify cannot register the route.
 * @remarks The handler waits for the shared connection attempt and returns its
 * settled status. A full queue returns service-busy Problem Details; other
 * failures remain owned by Fastify's parent error boundary. A client
 * disconnect does not cancel an accepted attempt.
 */
export default async function updateFastifyWithLlmRuntimeConnectRoute(
  app: FastifyInstance
): Promise<void> {
  const llmRuntimeConnector: LlmRuntimeConnector = app.llmRuntimeService

  app.route<LlmRuntimeConnectApiRoute>({
    method: llmRuntimeConnectApi.method,
    url: llmRuntimeConnectApi.path,
    schema: {
      response: {
        200: z.toJSONSchema(llmRuntimeConnectApi.responses[200], {
          target: "draft-7"
        }),
        503: z.toJSONSchema(llmRuntimeConnectApi.responses[503], {
          target: "draft-7"
        })
      }
    },
    errorHandler: handleLlmServiceRequestFailure,
    handler: async function () {
      const status = await llmRuntimeConnector.connectLlmRuntime()
      return Object.freeze({ status })
    }
  })
}
