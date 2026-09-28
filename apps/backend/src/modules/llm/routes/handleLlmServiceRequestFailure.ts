import {
  createLlmRuntimeUnavailableProblem,
  createLlmServiceBusyProblem
} from "@lys/protocol"
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify"
import { isLlmRuntimeUnavailableError } from "../llmRuntimeUnavailableError"
import { isLlmServiceBusyError } from "../llmServiceBusyError"

/**
 * Maps recognized model-operation failures to caller-safe HTTP responses.
 *
 * @param failure - Untrusted failure received by a model route's error boundary.
 * @param request - Request forwarded unchanged to the existing application boundary.
 * @param reply - Borrowed response for the failed model request.
 * @throws If the existing application error handler fails.
 * @remarks Service-busy and runtime-unavailable failures become their 503
 * Problem Details. Only a recognized service rejection establishes that no work
 * was accepted. A runtime-unavailable failure that retains original runtime
 * failures is logged at `warn` before the response; a refusal without runtime
 * work is not. Internal error evidence is excluded from the public projection.
 * Unrecognized failures are delegated directly because Fastify's rethrow path
 * bypasses a parent error handler for non-Error rejection values.
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

  if (isLlmRuntimeUnavailableError(failure)) {
    if (failure.errors.length > 0) {
      request.log.warn(
        { err: failure },
        "LM Studio stopped answering during a model operation"
      )
    }
    const problem = createLlmRuntimeUnavailableProblem(
      "LM Studio is not reachable. Start LM Studio, then refresh its status in Lys."
    )
    reply.type(problemDetailsMediaType).code(503).send(problem)
    return
  }

  reply.server.errorHandler(failure, request, reply)
}
