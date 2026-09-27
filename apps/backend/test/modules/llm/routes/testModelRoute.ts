import { llmTestModelApi, type LlmTestModelApiRoute } from "@lys/protocol"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import * as z from "zod"
import type { LlmModelHealthReader } from "../llmModelCapabilities"
import type { LlmModelHealthDiagnostic } from "../llmModelHealthDiagnostic"
import handleLlmServiceRequestFailure from "./handleLlmServiceRequestFailure"

/**
 * Adds the protocol-defined loaded-model health endpoint to a Fastify application.
 *
 * @param app - Application instance that receives the LLM health route.
 * @returns A promise that resolves after route registration completes.
 * @throws If Fastify cannot register the route.
 * @remarks Every response prevents caching because health is a fresh observation.
 * Refused queue admission returns service-busy Problem Details. Accepted health
 * work remains owned by the application service after client disconnect.
 */
export default async function updateFastifyWithLlmTestModelRoute(
  app: FastifyInstance
): Promise<void> {
  const llmModelHealthReader: LlmModelHealthReader = app.llmService

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
    validatorCompiler: () => validateLlmTestModelParams,
    onRequest: async (_request, reply) => {
      reply.header("Cache-Control", "no-store")
    },
    errorHandler: handleLlmServiceRequestFailure,
    handler: async (request, reply) =>
      await handleLlmTestModelRequest(request, reply, llmModelHealthReader)
  })
}

/**
 * Validates untrusted path parameters for one model-health request.
 *
 * @param data - Decoded path parameters supplied by Fastify.
 * @returns Fastify's success value or validation-error representation.
 */
function validateLlmTestModelParams(data: unknown) {
  const paramsValidationResult = llmTestModelApi.params.safeParse(data)
  return paramsValidationResult.success
    ? { value: paramsValidationResult.data }
    : { error: paramsValidationResult.error }
}

/**
 * Returns one fresh loaded-state observation for a canonical model key.
 *
 * @param request - Validated request containing the canonical model key.
 * @param reply - Fastify reply used for the validated health response.
 * @param llmModelHealthReader - Application capability that queries loaded state.
 * @returns A promise that resolves after the health response is sent.
 * @throws If admission is refused or an unexpected application failure occurs.
 * The route boundary translates only recognized admission rejection.
 * @remarks Internal runtime diagnostics are logged and excluded from the body.
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
  diagnostic: LlmModelHealthDiagnostic,
  request: FastifyRequest<LlmTestModelApiRoute>,
  modelKey: string
): void {
  diagnostic.handleLlmModelHealthFailureReport((failure) =>
    request.log.error(
      { err: failure, modelKey },
      "LLM runtime state could not be established during model health query"
    )
  )
}
