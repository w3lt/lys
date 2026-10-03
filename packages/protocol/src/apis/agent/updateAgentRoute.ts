import { agentChangesSchema, agentSchema } from "@lys/share"
import type * as z from "zod"
import {
  agentNotFoundProblemSchema,
  type AgentNotFoundProblem
} from "../../http/errors/agent"
import { agentPathParamsSchema, type AgentPathParams } from "./_share"
import { apiAgentRoute } from "./routes"

/** Selects the update-agent failure validator by HTTP status. */
const updateAgentApiResponseSchemas = Object.freeze({
  404: agentNotFoundProblemSchema
})

/**
 * Describes the PATCH endpoint that changes one stored agent's name, bio, or
 * system prompt.
 *
 * @remarks The body names at least one field; each given field replaces the
 * stored value, trimmed, and an omitted field keeps it. The code comes from
 * the path and cannot be changed. Success persists the change and its time
 * as `updatedAt` before responding with the changed agent, even when the
 * given values equal the stored ones; repeating a request stores the same
 * values. A missing agent returns the agent-not-found problem with HTTP 404
 * and changes nothing. Changing the method, path, or schemas requires
 * coordinated consumers.
 */
export const updateAgentApi = Object.freeze({
  method: "PATCH",
  path: apiAgentRoute,
  params: agentPathParamsSchema,
  body: agentChangesSchema,
  response: agentSchema,
  responses: updateAgentApiResponseSchemas
})

/** Validated body accepted by the update-agent endpoint. */
export type UpdateAgentApiRequestBody = z.infer<typeof updateAgentApi.body>

/** Changed agent returned by the update-agent endpoint. */
export type UpdateAgentApiResponse = z.infer<typeof updateAgentApi.response>

/** Status-specific payloads returned by the update-agent endpoint. */
export type UpdateAgentApiReply = {
  /** The agent with the change applied. */
  readonly 200: UpdateAgentApiResponse
  /** No agent is stored under the addressed code. */
  readonly 404: AgentNotFoundProblem
}

/** Fastify route type for the update-agent endpoint. */
export type UpdateAgentApiRoute = {
  /** Validated code of the agent to change. */
  readonly Params: AgentPathParams
  /** Validated fields to replace. */
  readonly Body: UpdateAgentApiRequestBody
  /** Status-specific agent and Problem Details payloads. */
  readonly Reply: UpdateAgentApiReply
}
