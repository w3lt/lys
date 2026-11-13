import * as z from "zod"
import {
  chatToolCallNotPendingProblemSchema,
  type ChatToolCallNotPendingProblem
} from "../../http/errors/chat"
import {
  chatToolApprovalTokenSchema,
  chatToolCallPathParamsSchema,
  type ChatToolCallPathParams
} from "./_share"
import { apiChatReplyToolApprovalRoute } from "./routes"

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

/** Field every tool-approval body adds to its answer. */
const chatToolApprovalTokenField = Object.freeze({
  /** Token of the prompt being answered, as its prompt carried it. */
  approvalToken: chatToolApprovalTokenSchema
})

/**
 * Validates the body of one answer to an approval prompt: the answer, and
 * the token the prompt carried.
 *
 * @remarks A body without a token fails validation. The backend takes the
 * answer only when the token is the one it sent with the call's prompt, and
 * only once; the reply's loop then reads the answer without its token.
 */
export const chatToolApprovalApiRequestBodySchema = z.discriminatedUnion(
  "status",
  [
    allowedChatToolApprovalSchema.extend(chatToolApprovalTokenField),
    rejectedChatToolApprovalSchema.extend(chatToolApprovalTokenField)
  ]
)

/** Body of one answer to an approval prompt, with the prompt's token. */
export type ChatToolApprovalApiRequestBody = z.infer<
  typeof chatToolApprovalApiRequestBodySchema
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
 * answered, expired, not waiting for approval, or whose reply ended, and an
 * answer whose token is not the prompt's, return the tool-call-not-pending
 * problem with HTTP 409 and change nothing, so a repeated request is harmless
 * and a wrong token tells the caller nothing about which calls wait. A prompt
 * waits for this request until `TOOL_APPROVAL_PROMPT_TIME_LIMIT_MINUTES`
 * minutes after it was sent, Stop, or backend shutdown; at the limit the
 * backend stores the call as failed without running it. A newer turn in the
 * conversation or deleting the conversation does not end the wait yet.
 * Changing the method, path, or schemas requires coordinated consumers.
 */
export const sendChatToolApprovalApi = Object.freeze({
  method: "POST",
  path: apiChatReplyToolApprovalRoute,
  params: chatToolCallPathParamsSchema,
  body: chatToolApprovalApiRequestBodySchema,
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
  readonly Params: ChatToolCallPathParams
  /** Validated answer and its prompt's token. */
  readonly Body: ChatToolApprovalApiRequestBody
  /** Status-specific empty success and Problem Details payloads. */
  readonly Reply: SendChatToolApprovalApiReply
}
