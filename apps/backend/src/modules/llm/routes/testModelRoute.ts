import { llmTestModelApi, type LlmTestModelApiRoute } from "@lys/protocol"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import * as z from "zod"
import type { LlmModelHealthReader } from "../llmModelCapabilities"
import type { LlmRuntimeFailureEvidence } from "../llmRuntimeFailureEvidence"
import handleLlmServiceRequestFailure from "./handleLlmServiceRequestFailure"
import { buildLlmRouteValidatorCompiler } from "./llmRouteValidation"

/**
 * Adds the protocol-defined loaded-model health endpoint to a Fastify application.
 *
 * @param app - Application instance that receives the LLM health route.
 * @returns A promise that resolves after route registration completes.
 * @throws If Fastify cannot register the route. The failure rejects the
 * promise rather than escaping the call synchronously.
 * @remarks Every response prevents caching because health is a fresh observation.
 * The model is observed on the provider the path names; a path naming no
 * known provider is refused with 400 before the handler runs. Refused queue
 * admission returns service-busy Problem Details, and a missing or lost LLM
 * runtime connection of the provider returns runtime-unavailable Problem
 * Details.
 * Accepted health work remains owned by the application service after client
 * disconnect.
 */
export default function updateFastifyWithLlmTestModelRoute(
  app: FastifyInstance
): Promise<void> {
  return new Promise((resolve) => {
    registerLlmTestModelRoute(app)
    resolve()
  })
}

/**
 * Registers the loaded-model health endpoint.
 *
 * @param app - Application instance that receives the route.
 * @throws If Fastify cannot register the route.
 */
function registerLlmTestModelRoute(app: FastifyInstance): void {
  const llmProviderServices = app.llmProviderServices

  app.route<LlmTestModelApiRoute>({
    method: llmTestModelApi.method,
    url: llmTestModelApi.path,
    schema: {
      params: z.toJSONSchema(llmTestModelApi.params, {
        target: "draft-7"
      }),
      response: {
        200: z.toJSONSchema(llmTestModelApi.responses[200], {
          target: "draft-7"
        }),
        503: z.toJSONSchema(llmTestModelApi.responses[503], {
          target: "draft-7"
        })
      }
    },
    validatorCompiler: buildLlmRouteValidatorCompiler({
      params: llmTestModelApi.params
    }),
    onRequest: (_request, reply) => {
      reply.header("Cache-Control", "no-store")
      return Promise.resolve()
    },
    errorHandler: handleLlmServiceRequestFailure,
    handler: async (request, reply) =>
      await handleLlmTestModelRequest(
        request,
        reply,
        llmProviderServices[request.params.provider].llmService
      )
  })
}

/**
 * Returns one fresh loaded-state observation for a canonical model key.
 *
 * @param request - Validated request containing the canonical model key.
 * @param reply - Fastify reply used for the validated health response.
 * @param llmModelHealthReader - Application capability of the provider the
 * path names that queries loaded state.
 * @returns A promise that resolves after the health response is sent.
 * @throws If admission is refused, no LLM runtime is connected, or an
 * unexpected application failure occurs. The route boundary translates only
 * the recognized service-busy and runtime-unavailable failures.
 * @remarks Internal runtime diagnostics are excluded from the body. Each
 * retained runtime failure is logged at error level with the failure as `err`,
 * the provider as `provider`, and the canonical model key as `modelKey`.
 */
async function handleLlmTestModelRequest(
  request: FastifyRequest<LlmTestModelApiRoute>,
  reply: FastifyReply<LlmTestModelApiRoute>,
  llmModelHealthReader: LlmModelHealthReader
): Promise<void> {
  const { modelId: modelKey } = request.params
  const outcome = await llmModelHealthReader.getLlmModelHealth(modelKey)

  for (const diagnostic of outcome.diagnostics) {
    reportLlmModelHealthFailure(diagnostic, request, modelKey)
  }

  reply.code(200).send(outcome.health)
}

/**
 * Reports one retained runtime failure through the request's structured logger.
 *
 * @param diagnostic - Opaque handle retaining the original runtime rejection.
 * @param request - Request whose logger receives the failure evidence.
 * @param modelKey - Canonical model key associated with the failed query.
 */
function reportLlmModelHealthFailure(
  diagnostic: LlmRuntimeFailureEvidence,
  request: FastifyRequest<LlmTestModelApiRoute>,
  modelKey: string
): void {
  diagnostic.handleLlmRuntimeFailureReport((failure) =>
    request.log.error(
      { err: failure, provider: request.params.provider, modelKey },
      "LLM runtime state could not be established during model health query"
    )
  )
}
