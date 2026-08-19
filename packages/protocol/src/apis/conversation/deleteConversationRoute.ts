import type * as z from "zod"
import { conversationApiParamsSchema } from "./getConversationRoute"
import { apiConversationRoute } from "./routes"

/**
 * Route contract for permanently deleting one conversation.
 *
 * @remarks Deletion removes the conversation and its messages. A successful
 * response carries no body, so the route declares no response schema.
 */
export const conversationDeleteApi = {
  method: "DELETE",
  path: apiConversationRoute,
  params: conversationApiParamsSchema,
  successStatus: 204
} as const

/** Fastify route generics for deleting one conversation. */
export type ConversationDeleteApiRoute = {
  Params: z.infer<typeof conversationApiParamsSchema>
}
