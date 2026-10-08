import {
  createLlmUnloadProblem,
  llmUnloadModelApi,
  type LlmUnloadModelApiRoute
} from "@lys/protocol"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import * as z from "zod"
import type { LlmModelStopper } from "../llmModelCapabilities"
import handleLlmServiceRequestFailure from "./handleLlmServiceRequestFailure"

/**
 * Adds the protocol-defined model-unload endpoint to a Fastify application.
 *
 * @param app - Application instance that receives the LLM unload route.
 * @returns A promise that resolves after the route is added.
 * @throws If Fastify cannot register the route. The failure rejects the
 * promise rather than escaping the call synchronously.
 * @remarks Refused queue admission returns service-busy Problem Details, and a
 * missing or lost LLM runtime connection returns runtime-unavailable Problem
 * Details. Other service rejections remain owned by Fastify's parent error
 * boundary.
 */
export default function updateFastifyWithLlmModelUnloadRoute(
  app: FastifyInstance
): Promise<void> {
  return new Promise((resolve) => {
    registerLlmModelUnloadRoute(app)
    resolve()
  })
}

/**
 * Registers the model-unload endpoint.
 *
 * @param app - Application instance that receives the route.
 * @throws If Fastify cannot register the route.
 */
function registerLlmModelUnloadRoute(app: FastifyInstance): void {
  const llmModelStopper: LlmModelStopper = app.llmService

  app.route<LlmUnloadModelApiRoute>({
    method: llmUnloadModelApi.method,
    url: llmUnloadModelApi.path,
    schema: {
      body: llmUnloadModelApi.body,
      response: {
        404: z.toJSONSchema(llmUnloadModelApi.responses[404], {
          target: "draft-7"
        }),
        503: z.toJSONSchema(llmUnloadModelApi.responses[503], {
          target: "draft-7"
        })
      }
    },
    validatorCompiler: () => (data) => {
      const bodyValidationResult = llmUnloadModelApi.body.safeParse(data)
      return bodyValidationResult.success
        ? { value: bodyValidationResult.data }
        : { error: bodyValidationResult.error }
    },
    errorHandler: handleLlmServiceRequestFailure,
    handler: async (request, reply) =>
      await handleLlmModelUnloadRequest(request, reply, llmModelStopper)
  })
}

/**
 * Handles one request to stop every loaded instance of a canonical model key.
 *
 * @param request - Validated request containing the canonical model key.
 * @param reply - Fastify reply used for status-specific responses.
 * @param llmModelStopper - Application capability that performs the reconciled stop.
 * @returns A promise that resolves after a response is sent.
 * @throws If admission is refused, no LLM runtime is connected, or
 * application cleanup has begun. The route boundary translates only the
 * recognized service-busy and runtime-unavailable failures.
 * @remarks Runtime diagnostics and reconciled failures are written to the
 * request logger before their HTTP outcome is sent: a stopped outcome with
 * diagnostics is logged at warn level, and runtime-unavailable and stop-failed
 * outcomes at error level. Each record carries the canonical model key as
 * `modelKey` and the outcome's `diagnostics`; a stop-failed record also
 * carries `remainingModelIdentifiers`.
 */
async function handleLlmModelUnloadRequest(
  request: FastifyRequest<LlmUnloadModelApiRoute>,
  reply: FastifyReply<LlmUnloadModelApiRoute>,
  llmModelStopper: LlmModelStopper
): Promise<void> {
  const { modelId: modelKey } = request.body
  const stopOutcome = await llmModelStopper.stopLlmModelsByKey(modelKey)

  switch (stopOutcome.status) {
    case "stopped": {
      if (stopOutcome.diagnostics.length > 0) {
        request.log.warn(
          { diagnostics: stopOutcome.diagnostics, modelKey },
          "LLM model stop reconciled after runtime failures"
        )
      }

      reply.code(204).send()
      return
    }
    case "not-loaded": {
      const problem = createLlmUnloadProblem({
        reason: "model-not-found",
        detail: `Model "${modelKey}" is not loaded.`
      })

      reply.type("application/problem+json").code(404).send(problem)
      return
    }
    case "runtime-unavailable": {
      request.log.error(
        { diagnostics: stopOutcome.diagnostics, modelKey },
        "LLM runtime state could not be established during model stop"
      )

      const problem = createLlmUnloadProblem({
        reason: "runtime-unavailable",
        detail: "The LLM runtime could not be queried."
      })

      reply.type("application/problem+json").code(503).send(problem)
      return
    }
    case "stop-failed": {
      request.log.error(
        {
          diagnostics: stopOutcome.diagnostics,
          modelKey,
          remainingModelIdentifiers: stopOutcome.remainingModelIdentifiers
        },
        "LLM model instances remain loaded after stop reconciliation"
      )

      const problem = createLlmUnloadProblem({
        reason: "unload-failed",
        detail: `Model "${modelKey}" remains loaded.`
      })

      reply.type("application/problem+json").code(503).send(problem)
      return
    }
  }
}
