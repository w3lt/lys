import {
  conversationNotFoundProblemSchema,
  type ConversationNotFoundProblem
} from "../../http/errors/conversation"
import {
  conversationPathParamsSchema,
  type ConversationPathParams
} from "./_share"
import { apiConversationRoute } from "./routes"

/** Selects the delete-conversation failure validator by HTTP status. */
const deleteConversationApiResponseSchemas = Object.freeze({
  404: conversationNotFoundProblemSchema
})

/**
 * Describes the DELETE endpoint that permanently removes one stored
 * conversation and its transcript.
 *
 * @remarks Success is a bodyless 204 sent after the conversation and every
 * message have been removed. Deletion cannot be undone. A missing conversation
 * returns the conversation-not-found problem with HTTP 404; clients may treat
 * that problem as confirmation that the conversation no longer exists.
 * Changing the method, path, or schemas requires coordinated consumers.
 */
export const deleteConversationApi = Object.freeze({
  method: "DELETE",
  path: apiConversationRoute,
  params: conversationPathParamsSchema,
  responses: deleteConversationApiResponseSchemas
})

/** Status-specific payloads returned by the delete-conversation endpoint. */
export type DeleteConversationApiReply = {
  /** The conversation and its transcript were removed. */
  readonly 204: undefined
  /** No conversation is stored under the addressed identifier. */
  readonly 404: ConversationNotFoundProblem
}

/** Fastify route type for the delete-conversation endpoint. */
export type DeleteConversationApiRoute = {
  /** Validated identifier of the conversation to delete. */
  readonly Params: ConversationPathParams
  /** Status-specific empty success and Problem Details payloads. */
  readonly Reply: DeleteConversationApiReply
}
