import {
  createLlmProviderLoadsModelsProblem,
  createLlmRuntimeUnavailableProblem,
  createLlmServiceBusyProblem
} from "@lys/protocol"
import {
  LLM_PROVIDER_NAMES,
  llmModelReferenceSchema,
  llmProviderSchema,
  type LlmProvider
} from "@lys/share"
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify"
import * as z from "zod"
import { isLlmProviderLoadsModelsError } from "../llmProviderLoadsModelsError"
import { isLlmRuntimeUnavailableError } from "../llmRuntimeUnavailableError"
import { isLlmServiceBusyError } from "../llmServiceBusyError"

/**
 * Validates the provider an LLM route's path names, beside any other path
 * parameter of the route, such as `modelId`.
 */
const llmProviderRequestParamsSchema = z.object({
  provider: llmProviderSchema
})

/** Validates the model, with its provider, a chat request's body names. */
const llmModelRequestBodySchema = z.object({
  model: llmModelReferenceSchema
})

/**
 * Maps recognized model-operation failures to caller-safe HTTP responses.
 *
 * @param failure - Untrusted failure received by a model route's error boundary.
 * @param request - Request forwarded unchanged to the existing application boundary.
 * @param reply - Borrowed response for the failed model request.
 * @throws If the existing application error handler fails.
 * @remarks Service-busy and runtime-unavailable failures become their 503
 * Problem Details, and a load or unload refused because the request's
 * provider loads its own models becomes 409 Problem Details; both details
 * name the provider {@link findLlmRequestProvider} finds, and speak of the
 * model provider when the request names none. Only a
 * recognized service rejection establishes that no work was accepted. A
 * runtime-unavailable failure that retains original runtime failures is
 * logged at `warn`, with the provider {@link findLlmRequestProvider} finds,
 * before the response; a refusal without runtime work is not. Internal error
 * evidence is excluded from the public projection. Unrecognized failures are
 * delegated directly because Fastify's rethrow path bypasses a parent error
 * handler for non-Error rejection values.
 */
export default function handleLlmServiceRequestFailure(
  failure: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply
): void {
  const problemDetailsMediaType = "application/problem+json"

  if (isLlmServiceBusyError(failure)) {
    const problem = createLlmServiceBusyProblem()
    reply.type(problemDetailsMediaType).code(503).send(problem)
    return
  }

  const providerName = formatLlmRequestProviderName(request)

  if (isLlmProviderLoadsModelsError(failure)) {
    const problem = createLlmProviderLoadsModelsProblem(
      `${providerName} decides which models are in memory, so Lys does not load or unload its models.`
    )
    reply.type(problemDetailsMediaType).code(409).send(problem)
    return
  }

  if (isLlmRuntimeUnavailableError(failure)) {
    if (failure.errors.length > 0) {
      request.log.warn(
        { err: failure, provider: findLlmRequestProvider(request) },
        "The model provider stopped answering during a model operation"
      )
    }
    const problem = createLlmRuntimeUnavailableProblem(
      `${providerName} is not reachable. Check it in Settings → Providers, then refresh its status in Lys.`
    )
    reply.type(problemDetailsMediaType).code(503).send(problem)
    return
  }

  reply.server.errorHandler(failure, request, reply)
}

/**
 * Names the provider a failed model request is for, as a sentence starts it.
 *
 * @param request - Failed request.
 * @returns The provider's display name, or "The model provider" when the
 * request names none.
 */
function formatLlmRequestProviderName(request: FastifyRequest): string {
  const provider = findLlmRequestProvider(request)
  return provider === undefined
    ? "The model provider"
    : LLM_PROVIDER_NAMES[provider]
}

/**
 * Finds the provider a failed model request is for.
 *
 * @param request - Failed request; its route validated the path and body
 * before the handler ran, and they are read again here because the error
 * boundary receives them untyped.
 * @returns The provider an LLM route's `:provider` path segment names, or
 * else the provider of the model a chat request's body names; undefined
 * when the request names neither, which no route this boundary serves does.
 */
function findLlmRequestProvider(
  request: FastifyRequest
): LlmProvider | undefined {
  const params = llmProviderRequestParamsSchema.safeParse(request.params)
  if (params.success) return params.data.provider
  const body = llmModelRequestBodySchema.safeParse(request.body)
  return body.success ? body.data.model.provider : undefined
}
