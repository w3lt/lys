import {
  createLlmUnloadProblem,
  llmUnloadModelApi,
  type LlmUnloadModelApiRoute
} from "@lys/protocol"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import * as z from "zod"
import type { LlmModelStopper } from "../llmModelCapabilities"
import type { LlmModelStopDiagnostic } from "../stopLlmModelsByKey"
import handleLlmServiceRequestFailure from "./handleLlmServiceRequestFailure"

/** Level of the log lines about the diagnostics of one stop outcome. */
type LlmModelStopDiagnosticLevel = "warn" | "error"

/** Fields that name what the log line about a diagnostic is about. */
type LlmModelStopDiagnosticFields = Readonly<{
  /** Canonical model key whose stop the diagnostic belongs to. */
  modelKey: string
  /** Operation that failed. */
  operation: LlmModelStopDiagnostic["operation"]
  /** Runtime identifier of a failed stop command; absent for an inventory. */
  modelIdentifier?: string
}>

/** Message of the log line about a diagnostic, by its failed operation. */
const LLM_MODEL_STOP_DIAGNOSTIC_MESSAGES: Readonly<
  Record<LlmModelStopDiagnostic["operation"], string>
> = Object.freeze({
  "list-initial-model-instances":
    "LLM runtime inventory could not be read before the model stop",
  "stop-model-instance": "LLM model instance could not be stopped",
  "list-reconciled-model-instances":
    "LLM runtime inventory could not be read after the model stop"
})

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
 * @remarks Each diagnostic of the outcome is written to the request logger
 * before the HTTP outcome is sent, with its retained failure as `err`, the
 * canonical model key as `modelKey`, the failed `operation`, and, for a stop
 * command, its `modelIdentifier`: at warn level when the stop reconciled
 * anyway, and at error level for the runtime-unavailable and stop-failed
 * outcomes. A stop-failed outcome also logs its `remainingModelIdentifiers`
 * at error level. No failure detail reaches the response body.
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
      reportLlmModelStopDiagnostics(
        stopOutcome.diagnostics,
        request,
        modelKey,
        "warn"
      )

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
      reportLlmModelStopDiagnostics(
        stopOutcome.diagnostics,
        request,
        modelKey,
        "error"
      )

      const problem = createLlmUnloadProblem({
        reason: "runtime-unavailable",
        detail: "The LLM runtime could not be queried."
      })

      reply.type("application/problem+json").code(503).send(problem)
      return
    }
    case "stop-failed": {
      reportLlmModelStopDiagnostics(
        stopOutcome.diagnostics,
        request,
        modelKey,
        "error"
      )
      request.log.error(
        {
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

/**
 * Reports each diagnostic of a stop outcome through the request's structured
 * logger, in the outcome's order.
 *
 * @param diagnostics - Diagnostics of the outcome, each retaining its failure.
 * @param request - Request whose logger receives the failure evidence.
 * @param modelKey - Canonical model key whose stop the diagnostics belong to.
 * @param level - Level of each line.
 */
function reportLlmModelStopDiagnostics(
  diagnostics: readonly LlmModelStopDiagnostic[],
  request: FastifyRequest<LlmUnloadModelApiRoute>,
  modelKey: string,
  level: LlmModelStopDiagnosticLevel
): void {
  for (const diagnostic of diagnostics) {
    const fields = buildLlmModelStopDiagnosticFields(diagnostic, modelKey)
    diagnostic.evidence.handleLlmRuntimeFailureReport((failure) =>
      request.log[level](
        { err: failure, ...fields },
        LLM_MODEL_STOP_DIAGNOSTIC_MESSAGES[diagnostic.operation]
      )
    )
  }
}

/**
 * Builds the fields that name what a diagnostic's line is about.
 *
 * @param diagnostic - Diagnostic the line reports.
 * @param modelKey - Canonical model key whose stop the diagnostic belongs to.
 * @returns The model key and the failed operation, with the runtime
 * identifier of a failed stop command.
 */
function buildLlmModelStopDiagnosticFields(
  diagnostic: LlmModelStopDiagnostic,
  modelKey: string
): LlmModelStopDiagnosticFields {
  switch (diagnostic.operation) {
    case "stop-model-instance":
      return Object.freeze({
        modelKey,
        operation: diagnostic.operation,
        modelIdentifier: diagnostic.modelIdentifier
      })
    case "list-initial-model-instances":
    case "list-reconciled-model-instances":
      return Object.freeze({ modelKey, operation: diagnostic.operation })
  }
}
