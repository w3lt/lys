import * as z from "zod"
import {
  chatToolCallNotPendingProblemSchema,
  type ChatToolCallNotPendingProblem
} from "../../http/errors/chat"
import { apiChatReplyToolApprovalRoute } from "./routes"
import {
  chatToolResultPathParamsSchema,
  type ChatToolResultPathParams
} from "./toolResultRoute"

/** Validates the answer that lets the backend go on with one call. */
const allowedChatToolApprovalSchema = z.strictObject({
  /** The person allowed the call. */
  status: z.literal("allowed")
})

/**
 * Validates the answer that stops one call before anything runs.
 *
 * @remarks `reason` tells the backend why the call was not allowed and is
 * not shown to the model: `declined` when the person rejected the call, and
 * `showFailed` when the client could not show the call to the person, such
 * as a tool it does not list or arguments it cannot describe.
 */
const rejectedChatToolApprovalSchema = z.strictObject({
  /** The call was not allowed and does not run. */
  status: z.literal("rejected"),
  /** Why the call was not allowed. */
  reason: z.enum(["declined", "showFailed"]),
  /** Non-empty explanation the model reads, including the person's note. */
  content: z.string().min(1)
})

/**
 * Validates the answer a client gives to one approval prompt.
 *
 * @remarks After `allowed`, the backend runs a backend tool itself and asks
 * the client to run a client tool with a `tool-call` event under the same
 * identifier. After `rejected`, the model reads `content` instead of a
 * result and nothing runs.
 */
export const chatToolApprovalAnswerSchema = z.discriminatedUnion("status", [
  allowedChatToolApprovalSchema,
  rejectedChatToolApprovalSchema
])

/** Answer a client gives to one approval prompt. */
export type ChatToolApprovalAnswer = z.infer<
  typeof chatToolApprovalAnswerSchema
>

/** Selects the tool-approval failure validator by HTTP status. */
const sendChatToolApprovalApiResponseSchemas = Object.freeze({
  409: chatToolCallNotPendingProblemSchema
})

/**
 * Describes the POST endpoint that answers one approval prompt of a running
 * reply.
 *
 * @remarks Success is a bodyless 204 sent once the answer is accepted; the
 * reply's loop then continues with the call. A call that is unknown, already
 * answered, not waiting for approval, or whose reply ended returns the
 * tool-call-not-pending problem with HTTP 409 and changes nothing, so a
 * repeated request is harmless. The backend sets no time limit on a prompt:
 * it waits until this request, Stop, or backend shutdown. A newer turn in the
 * conversation or deleting the conversation does not end the wait yet.
 * Changing the method, path, or schemas requires coordinated consumers.
 */
export const sendChatToolApprovalApi = Object.freeze({
  method: "POST",
  path: apiChatReplyToolApprovalRoute,
  params: chatToolResultPathParamsSchema,
  body: chatToolApprovalAnswerSchema,
  responses: sendChatToolApprovalApiResponseSchemas
})

/** Status-specific payloads returned by the tool-approval endpoint. */
export type SendChatToolApprovalApiReply = {
  /** The answer was accepted and the reply's loop continues. */
  readonly 204: undefined
  /** The call is not waiting for approval; nothing changed. */
  readonly 409: ChatToolCallNotPendingProblem
}

/** Fastify route type for the tool-approval endpoint. */
export type SendChatToolApprovalApiRoute = {
  /** Validated identifiers of the call being answered. */
  readonly Params: ChatToolResultPathParams
  /** Validated answer. */
  readonly Body: ChatToolApprovalAnswer
  /** Status-specific empty success and Problem Details payloads. */
  readonly Reply: SendChatToolApprovalApiReply
}
