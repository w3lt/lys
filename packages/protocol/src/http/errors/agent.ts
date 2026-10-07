import * as z from "zod"

/** Stable problem category for a request naming an agent that does not exist. */
const AGENT_NOT_FOUND_PROBLEM_TYPE = "urn:lys:problem:agent:not-found"

/** Client-facing summary shared by every missing-agent occurrence. */
const AGENT_NOT_FOUND_PROBLEM_TITLE = "Agent not found"

/** HTTP status accompanying a missing-agent problem body. */
const AGENT_NOT_FOUND_PROBLEM_STATUS = 404

/** Stable problem category for creating an agent under a code already stored. */
const AGENT_CODE_TAKEN_PROBLEM_TYPE = "urn:lys:problem:agent:code-taken"

/** Client-facing summary shared by every taken-code occurrence. */
const AGENT_CODE_TAKEN_PROBLEM_TITLE = "Agent code taken"

/** HTTP status accompanying a taken-code problem body. */
const AGENT_CODE_TAKEN_PROBLEM_STATUS = 409

/**
 * Validates the RFC 9457 body returned when a request names an agent that
 * does not exist.
 *
 * @remarks The get, update, and delete agent endpoints transmit this contract
 * with HTTP 404 when no stored agent has the code. The chat endpoint
 * transmits it with HTTP 404 when it would start a conversation with an agent
 * that cannot answer chats; for now only Lys can. Either way the request
 * changed nothing. The `type` literal is the machine-readable discriminator;
 * consumers branch on it and never on
 * `detail`, which is occurrence-specific, caller-safe text. A 404 response
 * without this body, such as an unregistered route, is not evidence that an
 * agent is absent. Changing any fixed field requires coordinated consumers.
 */
export const agentNotFoundProblemSchema = z
  .strictObject({
    /** Stable discriminator separating a missing agent from other failures. */
    type: z.literal(AGENT_NOT_FOUND_PROBLEM_TYPE),
    /** Human-readable category summary shared across occurrences. */
    title: z.literal(AGENT_NOT_FOUND_PROBLEM_TITLE),
    /** HTTP status accompanying this problem body. */
    status: z.literal(AGENT_NOT_FOUND_PROBLEM_STATUS),
    /** Caller-safe explanation of this occurrence. */
    detail: z.string().min(1),
    /** Optional identifier of this problem occurrence. */
    instance: z.string().min(1).optional()
  })
  .readonly()

/** Missing-agent Problem Details body inferred from its schema. */
export type AgentNotFoundProblem = z.infer<typeof agentNotFoundProblemSchema>

/**
 * Validates the RFC 9457 body returned when a create request names a code
 * that another stored agent already has.
 *
 * @remarks The create-agent endpoint transmits this contract with HTTP 409
 * when the request carries a code that another stored agent or Lys has; the
 * stored agent is left unchanged and nothing is created. A request without a
 * code never receives it. The `type` literal is the machine-readable discriminator; `detail` is
 * caller-safe text. Changing any fixed field requires coordinated consumers.
 */
export const agentCodeTakenProblemSchema = z
  .strictObject({
    /** Stable discriminator separating a taken code from other failures. */
    type: z.literal(AGENT_CODE_TAKEN_PROBLEM_TYPE),
    /** Human-readable category summary shared across occurrences. */
    title: z.literal(AGENT_CODE_TAKEN_PROBLEM_TITLE),
    /** HTTP status accompanying this problem body. */
    status: z.literal(AGENT_CODE_TAKEN_PROBLEM_STATUS),
    /** Caller-safe explanation of this occurrence. */
    detail: z.string().min(1),
    /** Optional identifier of this problem occurrence. */
    instance: z.string().min(1).optional()
  })
  .readonly()

/** Taken-code Problem Details body inferred from its schema. */
export type AgentCodeTakenProblem = z.infer<typeof agentCodeTakenProblemSchema>
