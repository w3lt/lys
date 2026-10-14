import * as z from "zod"
import {
  chatToolCallNotPendingProblemSchema,
  type ChatToolCallNotPendingProblem
} from "../../http/errors/chat"
import {
  chatToolCallPathParamsSchema,
  type ChatToolCallPathParams
} from "./_share"
import { apiChatReplyToolResultRoute } from "./routes"

/** Bytes in one mebibyte. */
const BYTES_PER_MEBIBYTE = 1024 * 1024

/**
 * Largest tool-result body, in bytes, that the tool-result endpoint accepts.
 *
 * @remarks Larger than the 1 MiB default of other routes so that a 1 MiB
 * file read still fits after JSON escaping, which can make text up to six
 * times longer. The backend enforces it as the route's body limit and answers
 * a larger body with `413`.
 */
export const MAXIMUM_TOOL_RESULT_BODY_BYTES = 8 * BYTES_PER_MEBIBYTE

/** Validates the answer of a client tool that ran and returned its output. */
const succeededChatToolResultSchema = z.strictObject({
  /** The tool ran and returned its output. */
  status: z.literal("succeeded"),
  /** Output the model reads; empty when the tool returned nothing, such as an empty file. */
  content: z.string()
})

/**
 * Validates the answer of a call that produced no output.
 *
 * @remarks `reason` tells the backend why the call failed and is not shown
 * to the model: `toolFailed` when the tool ran and reported a failure, and
 * `runFailed` when the client could not run the tool.
 */
const failedChatToolResultSchema = z.strictObject({
  /** The call produced no output. */
  status: z.literal("failed"),
  /** Why the call failed. */
  reason: z.enum(["toolFailed", "runFailed"]),
  /** Non-empty explanation the model reads. */
  content: z.string().min(1)
})

/**
 * Validates what a client tool's call returned after the client ran it, or
 * why it produced no output.
 *
 * @remarks `content` is the exact text the model reads.
 */
export const chatToolResultSchema = z.discriminatedUnion("status", [
  succeededChatToolResultSchema,
  failedChatToolResultSchema
])

/** What a client tool's call returned, or why it produced no output. */
export type ChatToolResult = z.infer<typeof chatToolResultSchema>

/** Selects the tool-result failure validator by HTTP status. */
const sendChatToolResultApiResponseSchemas = Object.freeze({
  409: chatToolCallNotPendingProblemSchema
})

/**
 * Describes the POST endpoint that answers one run request of a running
 * reply with the client tool's result.
 *
 * @remarks Success is a bodyless 204 sent once the result is accepted; the
 * reply's loop then continues. A call that is unknown, already answered,
 * not waiting for its result, or whose reply ended returns the
 * tool-call-not-pending problem with HTTP 409 and changes nothing, so a
 * repeated request is harmless. The body is limited to
 * {@link MAXIMUM_TOOL_RESULT_BODY_BYTES}. The backend sets no time limit on
 * a pending call: it waits until this request, Stop, or backend shutdown. A
 * newer turn in the conversation or deleting the conversation does not end
 * the wait yet. Changing the method, path, or schemas requires coordinated
 * consumers.
 */
export const sendChatToolResultApi = Object.freeze({
  method: "POST",
  path: apiChatReplyToolResultRoute,
  params: chatToolCallPathParamsSchema,
  body: chatToolResultSchema,
  bodyLimitBytes: MAXIMUM_TOOL_RESULT_BODY_BYTES,
  responses: sendChatToolResultApiResponseSchemas
})

/** Status-specific payloads returned by the tool-result endpoint. */
export type SendChatToolResultApiReply = {
  /** The result was accepted and the reply's loop continues. */
  readonly 204: undefined
  /** The call is not waiting for its result; nothing changed. */
  readonly 409: ChatToolCallNotPendingProblem
}

/** Fastify route type for the tool-result endpoint. */
export type SendChatToolResultApiRoute = {
  /** Validated identifiers of the call being answered. */
  readonly Params: ChatToolCallPathParams
  /** Validated result. */
  readonly Body: ChatToolResult
  /** Status-specific empty success and Problem Details payloads. */
  readonly Reply: SendChatToolResultApiReply
}
