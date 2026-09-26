import * as z from "zod"

/** Stable problem category for a route naming a conversation that is not stored. */
const CONVERSATION_NOT_FOUND_PROBLEM_TYPE =
  "urn:lys:problem:conversation:not-found"

/** Client-facing summary shared by every missing-conversation occurrence. */
const CONVERSATION_NOT_FOUND_PROBLEM_TITLE = "Conversation not found"

/** HTTP status accompanying a missing-conversation problem body. */
const CONVERSATION_NOT_FOUND_PROBLEM_STATUS = 404

/**
 * Validates the RFC 9457 body returned when a conversation route names a
 * conversation that is not stored.
 *
 * @remarks The get, title-update, and delete conversation endpoints transmit
 * this contract with HTTP 404. The `type` literal is the machine-readable
 * discriminator; consumers branch on it and never on `detail`, which is
 * occurrence-specific, caller-safe text. A 404 response without this body,
 * such as an unregistered route, is not evidence that a conversation is
 * absent. Changing any fixed field requires coordinated consumers.
 */
export const conversationNotFoundProblemSchema = z
  .strictObject({
    /** Stable discriminator separating a missing conversation from other failures. */
    type: z.literal(CONVERSATION_NOT_FOUND_PROBLEM_TYPE),
    /** Human-readable category summary shared across occurrences. */
    title: z.literal(CONVERSATION_NOT_FOUND_PROBLEM_TITLE),
    /** HTTP status accompanying this problem body. */
    status: z.literal(CONVERSATION_NOT_FOUND_PROBLEM_STATUS),
    /** Caller-safe explanation of this occurrence. */
    detail: z.string().min(1),
    /** Optional identifier of this problem occurrence. */
    instance: z.string().min(1).optional()
  })
  .readonly()

/** Missing-conversation Problem Details body inferred from its schema. */
export type ConversationNotFoundProblem = z.infer<
  typeof conversationNotFoundProblemSchema
>
