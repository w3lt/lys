import {
  llmRuntimeConnectApi,
  type LlmRuntimeConnectApiRoute
} from "@lys/protocol"
import type { FastifyInstance } from "fastify"
import * as z from "zod"
import type { LlmRuntimeConnector } from "../llmRuntimeCapabilities"
import handleLlmServiceRequestFailure from "./handleLlmServiceRequestFailure"
import { buildLlmRouteValidatorCompiler } from "./llmRouteValidation"

/**
 * Adds the protocol-defined LLM runtime connect endpoint to a Fastify application.
 *
 * @param app - Application instance that receives the runtime-connect route.
 * @returns A promise that resolves after route registration completes.
 * @throws If Fastify cannot register the route. The failure rejects the
 * promise rather than escaping the call synchronously.
 * @remarks The handler waits for the shared connection attempt of the
 * provider the path names and returns its settled status; a path naming no
 * known provider is refused with 400 before the handler runs. A full queue
 * returns service-busy Problem Details; other
 * failures remain owned by Fastify's parent error boundary. A client
 * disconnect does not cancel an accepted attempt.
 */
export default function updateFastifyWithLlmRuntimeConnectRoute(
  app: FastifyInstance
): Promise<void> {
  return new Promise((resolve) => {
    registerLlmRuntimeConnectRoute(app)
    resolve()
  })
}

/**
 * Registers the LLM runtime connect endpoint.
 *
 * @param app - Application instance that receives the route.
 * @throws If Fastify cannot register the route.
 */
function registerLlmRuntimeConnectRoute(app: FastifyInstance): void {
  const llmProviderServices = app.llmProviderServices

  app.route<LlmRuntimeConnectApiRoute>({
    method: llmRuntimeConnectApi.method,
    url: llmRuntimeConnectApi.path,
    schema: {
      params: z.toJSONSchema(llmRuntimeConnectApi.params, {
        target: "draft-7"
      }),
      response: {
        200: z.toJSONSchema(llmRuntimeConnectApi.responses[200], {
          target: "draft-7"
        }),
        503: z.toJSONSchema(llmRuntimeConnectApi.responses[503], {
          target: "draft-7"
        })
      }
    },
    validatorCompiler: buildLlmRouteValidatorCompiler({
      params: llmRuntimeConnectApi.params
    }),
    errorHandler: handleLlmServiceRequestFailure,
    handler: async function (request) {
      const llmRuntimeConnector: LlmRuntimeConnector =
        llmProviderServices[request.params.provider].llmRuntimeService
      const status = await llmRuntimeConnector.connectLlmRuntime()
      return Object.freeze({ status })
    }
  })
}
