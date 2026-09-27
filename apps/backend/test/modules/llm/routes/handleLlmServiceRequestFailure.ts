import { createLlmServiceBusyProblem } from "@lys/protocol"
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify"
import { isLlmServiceBusyError } from "../llmServiceBusyError"

/**
 * Maps refused model-operation admission to its caller-safe HTTP response.
 *
 * @param failure - Untrusted failure received by a model route's error boundary.
 * @param request - Request forwarded unchanged to the existing application boundary.
 * @param reply - Borrowed response for the failed model request.
 * @throws If the existing application error handler fails.
 * @remarks Only a recognized service rejection establishes that no work was
 * accepted. Internal error evidence is excluded from the public projection.
 * Unrecognized failures are delegated directly because Fastify's rethrow path
 * bypasses a parent error handler for non-Error rejection values.
 */
export default function handleLlmServiceRequestFailure(
  failure: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply
): void {
  if (!isLlmServiceBusyError(failure)) {
    return reply.server.errorHandler(failure, request, reply)
  }

  const problem = createLlmServiceBusyProblem()
  reply.type("application/problem+json").code(503).send(problem)
}
