import * as z from "zod"
import { conversationSummarySchema } from "./_share"
import { apiConversationListRoute } from "./routes"

/**
 * Query accepted when listing conversations.
 *
 * @remarks Every property is optional and serialized as a string in the URL,
 * so `limit` is coerced. Omitting `query` lists every conversation; supplying
 * it restricts the result to conversations whose title or message content
 * contains that substring, compared case-insensitively. `cursor` continues one
 * previous result and MUST be an opaque value returned by this route. A cursor
 * is only valid for the `query` that produced it. The backend owns the maximum
 * accepted `limit` and rejects a larger value.
 */
export const conversationListApiQuerySchema = z.strictObject({
  /** Case-insensitive substring matched against titles and message content. */
  query: z.string().optional(),
  /** Opaque continuation token returned by a previous response. */
  cursor: z.string().min(1).optional(),
  /** Maximum conversations returned by this page. */
  limit: z.coerce.number().int().positive().optional()
})

/**
 * Body returned when listing conversations.
 *
 * @remarks Conversations are ordered by descending update time and then by
 * descending identifier, so the order is stable across pages. `total` counts
 * every stored conversation and ignores the search query; `matchCount` counts
 * the conversations the query matched and equals `total` when no query was
 * supplied. Both counts describe the whole result rather than this page.
 * `nextCursor` is null exactly when no further page exists.
 */
export const conversationListApiResponseSchema = z.strictObject({
  /** Conversations in this page, in presentation order. */
  conversations: z.array(conversationSummarySchema),
  /** Number of stored conversations, ignoring the search query. */
  total: z.number().int().nonnegative(),
  /** Number of conversations matching the search query. */
  matchCount: z.number().int().nonnegative(),
  /** Cursor continuing this result, or null when the result is complete. */
  nextCursor: z.string().min(1).nullable()
})

/** Route contract for listing stored conversations. */
export const conversationListApi = {
  method: "GET",
  path: apiConversationListRoute,
  querystring: conversationListApiQuerySchema,
  response: conversationListApiResponseSchema
} as const

/** Query accepted when listing conversations. */
export type ConversationListApiQuery = z.infer<
  typeof conversationListApi.querystring
>

/** Body returned when listing conversations. */
export type ConversationListApiResponse = z.infer<
  typeof conversationListApi.response
>

/** Fastify route generics for listing stored conversations. */
export type ConversationListApiRoute = {
  Querystring: ConversationListApiQuery
  Reply: ConversationListApiResponse
}
