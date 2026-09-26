import { conversationSchema } from "@lys/share"
import {
  conversationNotFoundProblemSchema,
  type ConversationNotFoundProblem
} from "../../http/errors/conversation"
import {
  conversationPathParamsSchema,
  type ConversationPathParams
} from "./_share"
import { apiConversationRoute } from "./routes"
import type * as z from "zod"

/** Selects the get-conversation failure validator by HTTP status. */
const getConversationApiResponseSchemas = Object.freeze({
  404: conversationNotFoundProblemSchema
})

/**
 * Describes the GET endpoint that reads one stored conversation with its
 * complete transcript.
 *
 * @remarks A 200 response contains the persisted conversation, including its
 * system prompt and every message in persisted order. An assistant message may
 * still report `streaming` when its generation has not been finalized; the
 * response observes stored state and does not attach the reader to that
 * generation. A missing conversation returns the conversation-not-found
 * problem with HTTP 404. Changing the method, path, or schemas requires
 * coordinated consumers.
 */
export const getConversationApi = Object.freeze({
  method: "GET",
  path: apiConversationRoute,
  params: conversationPathParamsSchema,
  response: conversationSchema,
  responses: getConversationApiResponseSchemas
})

/** Persisted conversation returned by the get-conversation endpoint. */
export type GetConversationApiResponse = z.infer<
  typeof getConversationApi.response
>

/** Status-specific payloads returned by the get-conversation endpoint. */
export type GetConversationApiReply = {
  /** The addressed conversation with its complete transcript. */
  readonly 200: GetConversationApiResponse
  /** No conversation is stored under the addressed identifier. */
  readonly 404: ConversationNotFoundProblem
}

/** Fastify route type for the get-conversation endpoint. */
export type GetConversationApiRoute = {
  /** Validated identifier of the conversation to read. */
  readonly Params: ConversationPathParams
  /** Status-specific conversation and Problem Details payloads. */
  readonly Reply: GetConversationApiReply
}
