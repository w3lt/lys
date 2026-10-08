import * as z from "zod"
import {
  chatToolCallNotPendingProblemSchema,
  type ChatToolCallNotPendingProblem
} from "../../http/errors/chat"
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

/**
 * Validates the path parameters addressing one tool call of a reply.
 *
 * @remarks Every decoded identifier must be UUIDv7; a malformed one is
 * rejected with HTTP 400 before any lookup.
 */
export const chatToolResultPathParamsSchema = z
  .strictObject({
    /** UUIDv7 identity of the conversation that holds the reply. */
    conversationId: z.uuidv7(),
    /** UUIDv7 identity of the assistant reply that made the call. */
    assistantMessageId: z.uuidv7(),
    /** UUIDv7 the backend gave the call in its `tool-call` event. */
    callId: z.uuidv7()
  })
  .readonly()

/** Path parameters addressing one tool call of a reply. */
export type ChatToolResultPathParams = z.infer<
  typeof chatToolResultPathParamsSchema
>

/**
 * Validates the answer a client gives to one tool call.
 *
 * @remarks `content` is the exact text the model reads. `reason` tells the
 * backend why a call failed and is not shown to the model: `declined` when
 * the person said no or switched the tool or tool calls off, `toolFailed`
 * when the tool ran and reported a failure, and `runFailed` when the client
 * could not run the tool.
 */
export const chatToolResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    /** The tool ran and returned its output. */
    status: z.literal("succeeded"),
    /** Output the model reads; empty when the tool returned nothing, such as an empty file. */
    content: z.string()
  }),
  z.strictObject({
    /** The call produced no output. */
    status: z.literal("failed"),
    /** Why the call failed. */
    reason: z.enum(["declined", "toolFailed", "runFailed"]),
    /** Non-empty explanation the model reads. */
    content: z.string().min(1)
  })
])

/** Answer a client gives to one tool call. */
export type ChatToolResult = z.infer<typeof chatToolResultSchema>

/** Selects the tool-result failure validator by HTTP status. */
const sendChatToolResultApiResponseSchemas = Object.freeze({
  409: chatToolCallNotPendingProblemSchema
})

/**
 * Describes the POST endpoint that answers one tool call of a running reply.
 *
 * @remarks Success is a bodyless 204 sent once the answer is accepted; the
 * reply's loop then continues. A call that is unknown, already answered, or
 * whose reply ended returns the tool-call-not-pending problem with HTTP 409
 * and changes nothing, so a repeated request is harmless. The body is limited
 * to {@link MAXIMUM_TOOL_RESULT_BODY_BYTES}. The backend sets no time limit
 * on a pending call: it waits until this request, Stop, a newer turn in the
 * conversation, deletion of the conversation, or backend shutdown. Changing
 * the method, path, or schemas requires coordinated consumers.
 */
export const sendChatToolResultApi = Object.freeze({
  method: "POST",
  path: apiChatReplyToolResultRoute,
  params: chatToolResultPathParamsSchema,
  body: chatToolResultSchema,
  bodyLimitBytes: MAXIMUM_TOOL_RESULT_BODY_BYTES,
  responses: sendChatToolResultApiResponseSchemas
})

/** Status-specific payloads returned by the tool-result endpoint. */
export type SendChatToolResultApiReply = {
  /** The answer was accepted and the reply's loop continues. */
  readonly 204: undefined
  /** The call is not waiting for an answer; nothing changed. */
  readonly 409: ChatToolCallNotPendingProblem
}

/** Fastify route type for the tool-result endpoint. */
export type SendChatToolResultApiRoute = {
  /** Validated identifiers of the call being answered. */
  readonly Params: ChatToolResultPathParams
  /** Validated answer. */
  readonly Body: ChatToolResult
  /** Status-specific empty success and Problem Details payloads. */
  readonly Reply: SendChatToolResultApiReply
}
