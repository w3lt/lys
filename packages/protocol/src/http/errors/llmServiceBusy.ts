import * as z from "zod"

/** Stable problem category for operations rejected before queue acceptance. */
const LLM_SERVICE_BUSY_PROBLEM_TYPE = "urn:lys:problem:llm:service-busy"

/** Client-facing summary shared by every LLM queue admission rejection. */
const LLM_SERVICE_BUSY_PROBLEM_TITLE = "LLM service busy"

/** HTTP status for a model operation refused because the service queue is full. */
const LLM_SERVICE_BUSY_PROBLEM_STATUS = 503

/** Safe recovery guidance for an operation that never entered the service queue. */
const LLM_SERVICE_BUSY_PROBLEM_DETAIL =
  "The LLM service queue is full. This operation was not accepted. Try again after pending model operations finish."

/**
 * Validates the immutable RFC 9457 body for refused LLM queue admission.
 *
 * @remarks Every field is fixed and no occurrence-specific fields are accepted.
 * The version-one list, load, and unload endpoints transmit this contract only
 * when the operation was not accepted; changing it requires coordinated consumers.
 */
export const llmServiceBusyProblemSchema = z
  .strictObject({
    /** Stable discriminator for admission refusal, separate from operation failures. */
    type: z.literal(LLM_SERVICE_BUSY_PROBLEM_TYPE),
    /** Human-readable category summary shared across occurrences. */
    title: z.literal(LLM_SERVICE_BUSY_PROBLEM_TITLE),
    /** HTTP status accompanying this problem body. */
    status: z.literal(LLM_SERVICE_BUSY_PROBLEM_STATUS),
    /** Explains non-acceptance and when the caller may retry. */
    detail: z.literal(LLM_SERVICE_BUSY_PROBLEM_DETAIL)
  })
  .readonly()

/** Immutable admission-rejection body inferred from its authoritative schema. */
export type LlmServiceBusyProblem = z.infer<typeof llmServiceBusyProblemSchema>

/**
 * Creates an immutable Problem Details body for an operation refused admission.
 *
 * @returns The fixed, caller-safe response confirming the requested operation was not accepted.
 */
export function createLlmServiceBusyProblem(): LlmServiceBusyProblem {
  return Object.freeze({
    type: LLM_SERVICE_BUSY_PROBLEM_TYPE,
    title: LLM_SERVICE_BUSY_PROBLEM_TITLE,
    status: LLM_SERVICE_BUSY_PROBLEM_STATUS,
    detail: LLM_SERVICE_BUSY_PROBLEM_DETAIL
  })
}
