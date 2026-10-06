import { agentSchema } from "@lys/share"
import type * as z from "zod"
import {
  agentNotFoundProblemSchema,
  type AgentNotFoundProblem
} from "../../http/errors/agent"
import { agentPathParamsSchema, type AgentPathParams } from "./_share"
import { apiAgentRoute } from "./routes"

/** Selects the get-agent failure validator by HTTP status. */
const getAgentApiResponseSchemas = Object.freeze({
  404: agentNotFoundProblemSchema
})

/**
 * Describes the GET endpoint that reads one stored agent, including its
 * system prompt.
 *
 * @remarks The endpoint observes stored data and changes nothing. A missing
 * agent returns the agent-not-found problem with HTTP 404. Changing the
 * method, path, or schemas requires coordinated consumers.
 */
export const getAgentApi = Object.freeze({
  method: "GET",
  path: apiAgentRoute,
  params: agentPathParamsSchema,
  response: agentSchema,
  responses: getAgentApiResponseSchemas
})

/** Stored agent returned by the get-agent endpoint. */
export type GetAgentApiResponse = z.infer<typeof getAgentApi.response>

/** Status-specific payloads returned by the get-agent endpoint. */
export type GetAgentApiReply = {
  /** The addressed agent. */
  readonly 200: GetAgentApiResponse
  /** No agent is stored under the addressed code. */
  readonly 404: AgentNotFoundProblem
}

/** Fastify route type for the get-agent endpoint. */
export type GetAgentApiRoute = {
  /** Validated code of the agent to read. */
  readonly Params: AgentPathParams
  /** Status-specific agent and Problem Details payloads. */
  readonly Reply: GetAgentApiReply
}
