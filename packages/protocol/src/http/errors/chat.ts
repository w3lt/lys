import { toolNameSchema } from "@lys/share"
import * as z from "zod"
import { backendToolUnavailableReasonSchema } from "../../apis/tool/backendToolAvailability"

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
 * Validates the RFC 9457 body returned when an answer names a call that is
 * not waiting for that answer.
 *
 * @remarks The tool-result and tool-approval endpoints transmit this
 * contract with HTTP 409 when the call is unknown, was already answered,
 * waits for the other kind of answer, or its reply ended. The request
 * changed nothing. The `type` literal is the machine-readable
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

/** Stable problem category for offering a backend tool that cannot run now. */
const CHAT_BACKEND_TOOL_UNAVAILABLE_PROBLEM_TYPE =
  "urn:lys:problem:chat:backend-tool-unavailable"

/** Client-facing summary shared by every unavailable-tool occurrence. */
const CHAT_BACKEND_TOOL_UNAVAILABLE_PROBLEM_TITLE = "Backend tool unavailable"

/** HTTP status accompanying an unavailable-tool problem body. */
const CHAT_BACKEND_TOOL_UNAVAILABLE_PROBLEM_STATUS = 409

/**
 * Validates the RFC 9457 body returned when a chat request offers a backend
 * tool that cannot run now.
 *
 * @remarks The chat endpoint transmits this contract with HTTP 409 before it
 * stores anything, for the first offered tool that cannot run. `toolName` and
 * `reason` are extension members a client branches on; `detail` is
 * caller-safe text. Changing any fixed field requires coordinated consumers.
 */
export const chatBackendToolUnavailableProblemSchema = z
  .strictObject({
    /** Stable discriminator separating an unavailable tool from other failures. */
    type: z.literal(CHAT_BACKEND_TOOL_UNAVAILABLE_PROBLEM_TYPE),
    /** Human-readable category summary shared across occurrences. */
    title: z.literal(CHAT_BACKEND_TOOL_UNAVAILABLE_PROBLEM_TITLE),
    /** HTTP status accompanying this problem body. */
    status: z.literal(CHAT_BACKEND_TOOL_UNAVAILABLE_PROBLEM_STATUS),
    /** Caller-safe explanation of this occurrence. */
    detail: z.string().min(1),
    /** Optional identifier of this problem occurrence. */
    instance: z.string().min(1).optional(),
    /** Name of the offered tool that cannot run. */
    toolName: toolNameSchema,
    /** Why it cannot run. */
    reason: backendToolUnavailableReasonSchema
  })
  .readonly()

/** Unavailable-tool Problem Details body inferred from its schema. */
export type ChatBackendToolUnavailableProblem = z.infer<
  typeof chatBackendToolUnavailableProblemSchema
>
