import { agentSchema, builtInAgentSchema } from "@lys/share"
import * as z from "zod"
import {
  agentNotFoundProblemSchema,
  type AgentNotFoundProblem
} from "../../http/errors/agent"
import { agentPathParamsSchema, type AgentPathParams } from "./_share"
import { apiAgentRoute } from "./routes"

/**
 * Validates one agent as the get-agent endpoint returns it.
 *
 * @remarks `kind` selects the variant. A built-in agent ships with the
 * backend and carries no times; a custom agent is a stored one, with the
 * times it was created and last changed. Unknown fields are rejected.
 */
const getAgentApiResponseSchema = z
  .discriminatedUnion("kind", [
    builtInAgentSchema.unwrap().extend({
      /** The agent ships with the backend and cannot be changed or deleted. */
      kind: z.literal("built-in")
    }),
    agentSchema.unwrap().extend({
      /** The agent is a stored one, which can be changed and deleted. */
      kind: z.literal("custom")
    })
  ])
  .readonly()

/** Selects the get-agent failure validator by HTTP status. */
const getAgentApiResponseSchemas = Object.freeze({
  404: agentNotFoundProblemSchema
})

/**
 * Describes the GET endpoint that reads one built-in or stored agent,
 * including its system prompt.
 *
 * @remarks The endpoint observes the agents and changes nothing. A code that
 * no built-in or stored agent has returns the agent-not-found problem with
 * HTTP 404. Changing the method, path, or schemas requires coordinated
 * consumers.
 */
export const getAgentApi = Object.freeze({
  method: "GET",
  path: apiAgentRoute,
  params: agentPathParamsSchema,
  response: getAgentApiResponseSchema,
  responses: getAgentApiResponseSchemas
})

/** Built-in or stored agent returned by the get-agent endpoint. */
export type GetAgentApiResponse = z.infer<typeof getAgentApi.response>

/** Status-specific payloads returned by the get-agent endpoint. */
export type GetAgentApiReply = {
  /** The addressed agent. */
  readonly 200: GetAgentApiResponse
  /** No built-in or stored agent has the addressed code. */
  readonly 404: AgentNotFoundProblem
}

/** Fastify route type for the get-agent endpoint. */
export type GetAgentApiRoute = {
  /** Validated code of the agent to read. */
  readonly Params: AgentPathParams
  /** Status-specific agent and Problem Details payloads. */
  readonly Reply: GetAgentApiReply
}
