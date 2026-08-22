import * as z from "zod"
import { conversationSchema } from "@lys/share"
import { apiConversationRoute } from "./routes"

/**
 * Path parameters addressing one stored conversation.
 *
 * @remarks Shared by every item route in this module.
 */
export const conversationApiParamsSchema = z.strictObject({
  /** Identifier of the addressed conversation. */
  conversationId: z.uuidv7()
})

/** Route contract for reading one conversation and its complete transcript. */
export const conversationGetApi = {
  method: "GET",
  path: apiConversationRoute,
  params: conversationApiParamsSchema,
  response: conversationSchema
} as const

/** Path parameters addressing one stored conversation. */
export type ConversationApiParams = z.infer<typeof conversationApiParamsSchema>

/** Body returned when reading one conversation. */
export type ConversationGetApiResponse = z.infer<
  typeof conversationGetApi.response
>

/** Fastify route generics for reading one conversation. */
export type ConversationGetApiRoute = {
  Params: ConversationApiParams
  Reply: ConversationGetApiResponse
}
