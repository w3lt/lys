import {
  agentNotFoundProblemSchema,
  type AgentNotFoundProblem
} from "../../http/errors/agent"
import { agentPathParamsSchema, type AgentPathParams } from "./_share"
import { apiAgentRoute } from "./routes"

/** Selects the delete-agent failure validator by HTTP status. */
const deleteAgentApiResponseSchemas = Object.freeze({
  404: agentNotFoundProblemSchema
})

/**
 * Describes the DELETE endpoint that permanently removes one stored agent.
 *
 * @remarks Success is a bodyless 204 sent after the agent has been removed.
 * Deletion cannot be undone. A missing agent returns the agent-not-found
 * problem with HTTP 404; clients may treat that problem as confirmation that
 * the agent no longer exists. Changing the method, path, or schemas requires
 * coordinated consumers.
 */
export const deleteAgentApi = Object.freeze({
  method: "DELETE",
  path: apiAgentRoute,
  params: agentPathParamsSchema,
  responses: deleteAgentApiResponseSchemas
})

/** Status-specific payloads returned by the delete-agent endpoint. */
export type DeleteAgentApiReply = {
  /** The agent was removed. */
  readonly 204: undefined
  /** No agent is stored under the addressed code. */
  readonly 404: AgentNotFoundProblem
}

/** Fastify route type for the delete-agent endpoint. */
export type DeleteAgentApiRoute = {
  /** Validated code of the agent to delete. */
  readonly Params: AgentPathParams
  /** Status-specific empty success and Problem Details payloads. */
  readonly Reply: DeleteAgentApiReply
}
