import {
  conversationNotFoundProblemSchema,
  type ConversationNotFoundProblem
} from "../../http/errors/conversation"
import {
  conversationPathParamsSchema,
  type ConversationPathParams
} from "../conversation/_share"
import { apiChatJobsStopRoute } from "./routes"

/** Selects the jobs-stop failure validator by HTTP status. */
const stopConversationJobsApiResponseSchemas = Object.freeze({
  404: conversationNotFoundProblemSchema
})

/**
 * Describes the POST endpoint that stops every working job of one
 * conversation.
 *
 * @remarks The request has no body. Success is a bodyless 204 sent after
 * each stopped reply reached its stored final state, and also when no job of
 * the conversation was working. A missing conversation returns the
 * conversation-not-found problem with HTTP 404 and stops nothing. Changing
 * the method, path, or schemas requires coordinated consumers.
 */
export const stopConversationJobsApi = Object.freeze({
  method: "POST",
  path: apiChatJobsStopRoute,
  params: conversationPathParamsSchema,
  responses: stopConversationJobsApiResponseSchemas
})

/** Status-specific payloads returned by the jobs-stop endpoint. */
export type StopConversationJobsApiReply = {
  /** Every working job stopped, or none was working. */
  readonly 204: undefined
  /** No conversation is stored under the addressed identifier. */
  readonly 404: ConversationNotFoundProblem
}

/** Fastify route type for the jobs-stop endpoint. */
export type StopConversationJobsApiRoute = {
  /** Validated identifier of the conversation whose jobs stop. */
  readonly Params: ConversationPathParams
  /** Status-specific empty success and Problem Details payloads. */
  readonly Reply: StopConversationJobsApiReply
}
