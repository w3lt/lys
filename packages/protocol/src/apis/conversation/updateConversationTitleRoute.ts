import * as z from "zod"
import { conversationMetadataSchema } from "@lys/share"
import { conversationApiParamsSchema } from "./getConversationRoute"
import { apiConversationRoute } from "./routes"

/**
 * Body accepted when renaming one conversation.
 *
 * @remarks The title is the exact value to persist. The backend trims it and
 * rejects a value that is empty after trimming, so a client MUST NOT send a
 * blank title to clear a name. Renaming updates the conversation's
 * `updatedAt`, which also changes its position in the list ordering.
 */
export const conversationUpdateTitleApiRequestBodySchema = z.strictObject({
  /** Replacement title for the addressed conversation. */
  title: z.string().trim().min(1)
})

/** Route contract for renaming one conversation. */
export const conversationUpdateTitleApi = {
  method: "PATCH",
  path: apiConversationRoute,
  params: conversationApiParamsSchema,
  body: conversationUpdateTitleApiRequestBodySchema,
  response: conversationMetadataSchema
} as const

/** Body accepted when renaming one conversation. */
export type ConversationUpdateTitleApiRequestBody = z.infer<
  typeof conversationUpdateTitleApi.body
>

/** Body returned after renaming one conversation. */
export type ConversationUpdateTitleApiResponse = z.infer<
  typeof conversationUpdateTitleApi.response
>

/** Fastify route generics for renaming one conversation. */
export type ConversationUpdateTitleApiRoute = {
  Params: z.infer<typeof conversationApiParamsSchema>
  Body: ConversationUpdateTitleApiRequestBody
  Reply: ConversationUpdateTitleApiResponse
}
