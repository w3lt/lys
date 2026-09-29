import {
  chatReplyNotGeneratingProblemSchema,
  type ChatReplyNotGeneratingProblem
} from "../../http/errors/chat"
import { chatReplyPathParamsSchema, type ChatReplyPathParams } from "./_share"
import { apiChatReplyStopRoute } from "./routes"

/** Selects the reply-stop failure validator by HTTP status. */
const stopChatReplyApiResponseSchemas = Object.freeze({
  409: chatReplyNotGeneratingProblemSchema
})

/**
 * Describes the POST endpoint that stops one reply's running generation.
 *
 * @remarks The request has no body. Success is a bodyless 204 sent after the
 * reply's model request was cancelled and the reply reached its stored final
 * state: `interrupted`, or `completed` when the model finished first.
 * Followers of the reply receive the matching `interrupted` or `done` event.
 * Title generation for the turn is not cancelled, and a repeated request
 * while that title task runs also returns 204. When no generation is running
 * for the addressed reply, the endpoint returns the reply-not-generating
 * problem with HTTP 409 and changes nothing; it does not distinguish a
 * finished reply from one that is not stored. Changing the method, path, or
 * schemas requires coordinated consumers.
 */
export const stopChatReplyApi = Object.freeze({
  method: "POST",
  path: apiChatReplyStopRoute,
  params: chatReplyPathParamsSchema,
  responses: stopChatReplyApiResponseSchemas
})

/** Status-specific payloads returned by the reply-stop endpoint. */
export type StopChatReplyApiReply = {
  /** The generation stopped and the reply's final state is stored. */
  readonly 204: undefined
  /** No generation was running for the addressed reply. */
  readonly 409: ChatReplyNotGeneratingProblem
}

/** Fastify route type for the reply-stop endpoint. */
export type StopChatReplyApiRoute = {
  /** Validated identifiers of the reply to stop. */
  readonly Params: ChatReplyPathParams
  /** Status-specific empty success and Problem Details payloads. */
  readonly Reply: StopChatReplyApiReply
}
