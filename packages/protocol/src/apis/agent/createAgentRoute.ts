import { agentDefinitionSchema, agentSchema } from "@lys/share"
import type * as z from "zod"
import {
  agentCodeTakenProblemSchema,
  type AgentCodeTakenProblem
} from "../../http/errors/agent"
import { apiAgentsRoute } from "./routes"

/** Selects the create-agent failure validator by HTTP status. */
const createAgentApiResponseSchemas = Object.freeze({
  409: agentCodeTakenProblemSchema
})

/**
 * Describes the POST endpoint that stores a new agent.
 *
 * @remarks The body is an agent definition whose name, bio, and system prompt
 * are trimmed. A given `code` is stored exactly; when it is omitted, the
 * backend derives the code from the name. Success is a 201 sent after the
 * agent is stored, carrying the stored agent and a `Location` header with its
 * path. A given code that another agent already has, Lys's code `lys`
 * included, returns the agent-code-taken problem with HTTP 409 and stores
 * nothing. A derived code is never `lys`. The operation is
 * not idempotent: repeating a request without a code stores another agent
 * under the next free derived code. A lost response leaves the creation
 * uncertain; the agent list shows whether it happened. Changing the method,
 * path, or schemas requires coordinated consumers.
 */
export const createAgentApi = Object.freeze({
  method: "POST",
  path: apiAgentsRoute,
  body: agentDefinitionSchema,
  response: agentSchema,
  responses: createAgentApiResponseSchemas
})

/** Validated body accepted by the create-agent endpoint. */
export type CreateAgentApiRequestBody = z.infer<typeof createAgentApi.body>

/** Stored agent returned by the create-agent endpoint. */
export type CreateAgentApiResponse = z.infer<typeof createAgentApi.response>

/** Status-specific payloads returned by the create-agent endpoint. */
export type CreateAgentApiReply = {
  /** The new agent as stored. */
  readonly 201: CreateAgentApiResponse
  /** The given code is Lys's or already stored; nothing was created. */
  readonly 409: AgentCodeTakenProblem
}

/** Fastify route type for the create-agent endpoint. */
export type CreateAgentApiRoute = {
  /** Validated definition of the new agent. */
  readonly Body: CreateAgentApiRequestBody
  /** Status-specific agent and Problem Details payloads. */
  readonly Reply: CreateAgentApiReply
}
