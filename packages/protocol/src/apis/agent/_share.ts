import * as z from "zod"
import { agentCodeSchema } from "@lys/share"

/**
 * Validates the path parameters that address one built-in or stored agent.
 *
 * @remarks Shared by the get, update, and delete agent endpoints. The decoded
 * code must be a valid agent code; a malformed code is rejected before any
 * agent lookup, so it never produces a not-found problem.
 */
export const agentPathParamsSchema = z
  .strictObject({
    /** Code of the addressed agent, compared exactly. */
    agentCode: agentCodeSchema
  })
  .readonly()

/** Path parameters addressing one built-in or stored agent. */
export type AgentPathParams = z.infer<typeof agentPathParamsSchema>
