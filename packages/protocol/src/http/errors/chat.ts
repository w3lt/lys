import * as z from "zod"

/** Stable problem category for a reply route naming a reply that is not stored. */
const CHAT_REPLY_NOT_FOUND_PROBLEM_TYPE = "urn:lys:problem:chat:reply-not-found"

/** Client-facing summary shared by every missing-reply occurrence. */
const CHAT_REPLY_NOT_FOUND_PROBLEM_TITLE = "Reply not found"

/** HTTP status accompanying a missing-reply problem body. */
const CHAT_REPLY_NOT_FOUND_PROBLEM_STATUS = 404

/** Stable problem category for stopping a reply that has no running generation. */
const CHAT_REPLY_NOT_GENERATING_PROBLEM_TYPE =
  "urn:lys:problem:chat:reply-not-generating"

/** Client-facing summary shared by every not-generating occurrence. */
const CHAT_REPLY_NOT_GENERATING_PROBLEM_TITLE = "Reply not generating"

/** HTTP status accompanying a not-generating problem body. */
const CHAT_REPLY_NOT_GENERATING_PROBLEM_STATUS = 409

/**
 * Validates the RFC 9457 body returned when a reply route names an assistant
 * reply that its conversation does not hold.
 *
 * @remarks The reply-events endpoint transmits this contract with HTTP 404
 * when the addressed conversation exists but stores no assistant reply with
 * the addressed identifier. The `type` literal is the machine-readable
 * discriminator; `detail` is occurrence-specific, caller-safe text. Changing
 * any fixed field requires coordinated consumers.
 */
export const chatReplyNotFoundProblemSchema = z
  .strictObject({
    /** Stable discriminator separating a missing reply from other failures. */
    type: z.literal(CHAT_REPLY_NOT_FOUND_PROBLEM_TYPE),
    /** Human-readable category summary shared across occurrences. */
    title: z.literal(CHAT_REPLY_NOT_FOUND_PROBLEM_TITLE),
    /** HTTP status accompanying this problem body. */
    status: z.literal(CHAT_REPLY_NOT_FOUND_PROBLEM_STATUS),
    /** Caller-safe explanation of this occurrence. */
    detail: z.string().min(1),
    /** Optional identifier of this problem occurrence. */
    instance: z.string().min(1).optional()
  })
  .readonly()

/** Missing-reply Problem Details body inferred from its schema. */
export type ChatReplyNotFoundProblem = z.infer<
  typeof chatReplyNotFoundProblemSchema
>

/**
 * Validates the RFC 9457 body returned when a stop request names a reply
 * that has no running generation.
 *
 * @remarks The reply-stop endpoint transmits this contract with HTTP 409 when
 * the addressed reply's generation already ended or the reply is not stored.
 * The request changed nothing. The `type` literal is the machine-readable
 * discriminator; `detail` is occurrence-specific, caller-safe text. Changing
 * any fixed field requires coordinated consumers.
 */
export const chatReplyNotGeneratingProblemSchema = z
  .strictObject({
    /** Stable discriminator separating a finished reply from other failures. */
    type: z.literal(CHAT_REPLY_NOT_GENERATING_PROBLEM_TYPE),
    /** Human-readable category summary shared across occurrences. */
    title: z.literal(CHAT_REPLY_NOT_GENERATING_PROBLEM_TITLE),
    /** HTTP status accompanying this problem body. */
    status: z.literal(CHAT_REPLY_NOT_GENERATING_PROBLEM_STATUS),
    /** Caller-safe explanation of this occurrence. */
    detail: z.string().min(1),
    /** Optional identifier of this problem occurrence. */
    instance: z.string().min(1).optional()
  })
  .readonly()

/** Not-generating Problem Details body inferred from its schema. */
export type ChatReplyNotGeneratingProblem = z.infer<
  typeof chatReplyNotGeneratingProblemSchema
>

/** Stable problem category for answering a tool call that is not pending. */
const CHAT_TOOL_CALL_NOT_PENDING_PROBLEM_TYPE =
  "urn:lys:problem:chat:tool-call-not-pending"

/** Client-facing summary shared by every not-pending occurrence. */
const CHAT_TOOL_CALL_NOT_PENDING_PROBLEM_TITLE = "Tool call not pending"

/** HTTP status accompanying a not-pending problem body. */
const CHAT_TOOL_CALL_NOT_PENDING_PROBLEM_STATUS = 409

/**
 * Validates the RFC 9457 body returned when a tool result names a call that
 * is not waiting for an answer.
 *
 * @remarks The tool-result endpoint transmits this contract with HTTP 409
 * when the call is unknown, was already answered, or its reply ended. The
 * request changed nothing. The `type` literal is the machine-readable
 * discriminator; `detail` is occurrence-specific, caller-safe text. Changing
 * any fixed field requires coordinated consumers.
 */
export const chatToolCallNotPendingProblemSchema = z
  .strictObject({
    /** Stable discriminator separating a non-pending call from other failures. */
    type: z.literal(CHAT_TOOL_CALL_NOT_PENDING_PROBLEM_TYPE),
    /** Human-readable category summary shared across occurrences. */
    title: z.literal(CHAT_TOOL_CALL_NOT_PENDING_PROBLEM_TITLE),
    /** HTTP status accompanying this problem body. */
    status: z.literal(CHAT_TOOL_CALL_NOT_PENDING_PROBLEM_STATUS),
    /** Caller-safe explanation of this occurrence. */
    detail: z.string().min(1),
    /** Optional identifier of this problem occurrence. */
    instance: z.string().min(1).optional()
  })
  .readonly()

/** Tool-call-not-pending Problem Details body inferred from its schema. */
export type ChatToolCallNotPendingProblem = z.infer<
  typeof chatToolCallNotPendingProblemSchema
>
