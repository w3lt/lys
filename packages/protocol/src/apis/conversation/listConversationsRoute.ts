import * as z from "zod"
import { conversationMetadataSchema } from "@lys/share"
import { apiConversationsRoute } from "./routes"

/**
 * Inclusive maximum number of conversations one list page may contain.
 *
 * @remarks Transmitted as the upper bound of the `limit` query parameter and
 * enforced on the response collection. It is not persisted. Raising it is a
 * compatible change for clients; lowering it can reject existing requests.
 */
export const MAXIMUM_CONVERSATION_LIST_PAGE_SIZE = 50

/**
 * Inclusive maximum search-query length, counted in UTF-16 code units after
 * trimming surrounding whitespace.
 *
 * @remarks Transmitted limit shared by the list endpoint and its clients; it
 * is not persisted. Lowering it can reject queries that clients accept.
 */
export const MAXIMUM_CONVERSATION_SEARCH_QUERY_LENGTH = 200

/** Inclusive maximum length of the opaque continuation cursor in either direction. */
const MAXIMUM_CONVERSATION_LIST_CURSOR_LENGTH = 2048

/**
 * Validates the query parameters accepted by the conversation list endpoint.
 *
 * @remarks Every parameter is optional and omission has a distinct meaning; an
 * empty or whitespace-only `query` is rejected rather than treated as
 * omission, so clients omit the parameter to list without searching. `query`
 * is trimmed before its length is checked, and the numeric `limit` is decoded
 * from its query-string text.
 */
const listConversationsApiQuerySchema = z
  .strictObject({
    /**
     * Case-insensitive substring searched in conversation titles and message
     * content; omission lists every stored conversation.
     */
    query: z
      .string()
      .trim()
      .min(1)
      .max(MAXIMUM_CONVERSATION_SEARCH_QUERY_LENGTH)
      .optional(),
    /**
     * Opaque continuation returned by the previous page for the same query;
     * omission requests the first page.
     */
    cursor: z
      .string()
      .min(1)
      .max(MAXIMUM_CONVERSATION_LIST_CURSOR_LENGTH)
      .optional(),
    /** Requested page size; omission selects the backend's default page size. */
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAXIMUM_CONVERSATION_LIST_PAGE_SIZE)
      .optional()
  })
  .readonly()

/**
 * Validates the message summarized beneath one listed conversation's title.
 *
 * @remarks Without a search query, the backend selects the most recent message
 * with non-empty content. With a query, it selects the most recent message
 * whose content contains the query under the same case-insensitive comparison
 * used for matching, falling back to the most recent message when only the
 * title matched. `content` is the complete stored message text; clients
 * derive any shortened excerpt themselves.
 */
const conversationPreviewSchema = z
  .strictObject({
    /** Author of the previewed message. */
    role: z.enum(["user", "assistant"]),
    /** Complete, non-empty stored content of the previewed message. */
    content: z.string().min(1)
  })
  .readonly()

/**
 * Validates one listed conversation without its system prompt or transcript.
 *
 * @remarks This read projection derives its identity, title, and timestamps
 * from the persisted conversation metadata contract. `updatedAt` is the
 * activity time that orders the list.
 */
const conversationSummarySchema = conversationMetadataSchema
  .pick({ id: true, title: true, createdAt: true, updatedAt: true })
  .extend({
    /** Message shown beneath the title, or null when none has content. */
    preview: conversationPreviewSchema.nullable()
  })
  .readonly()

/**
 * Validates one page of listed conversations and its continuation state.
 *
 * @remarks Conversations are ordered by `updatedAt` descending, then by `id`
 * descending, and appear at most once per page. Each page observes the store
 * when it is read: a conversation updated after an earlier page was read can
 * move ahead of the cursor and be absent from later pages. `nextCursor` is
 * bound to the query that produced it and is null on the final page.
 */
const listConversationsApiResponseSchema = z
  .strictObject({
    /** Page of listed conversations in the documented order. */
    conversations: z
      .array(conversationSummarySchema)
      .max(MAXIMUM_CONVERSATION_LIST_PAGE_SIZE)
      .readonly(),
    /** Number of stored conversations, independent of the search query. */
    storedCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    /** Number of stored conversations matching the query, or all when omitted. */
    matchCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    /** Continuation for the next page of the same query, or null when final. */
    nextCursor: z
      .string()
      .min(1)
      .max(MAXIMUM_CONVERSATION_LIST_CURSOR_LENGTH)
      .nullable()
  })
  .refine(
    (page) =>
      page.matchCount <= page.storedCount &&
      page.conversations.length <= page.matchCount,
    { message: "Conversation counts must bound the listed page." }
  )
  .readonly()

/**
 * Describes the GET endpoint that lists stored conversations newest first.
 *
 * @remarks The endpoint observes stored data and changes nothing. The shared
 * descriptor is imported by the desktop client and the backend registrar;
 * changing its method, path, query, or response schema changes the transmitted
 * contract and requires coordinated consumers.
 */
export const listConversationsApi = Object.freeze({
  method: "GET",
  path: apiConversationsRoute,
  querystring: listConversationsApiQuerySchema,
  response: listConversationsApiResponseSchema
})

/** Validated query parameters accepted by the conversation list endpoint. */
export type ListConversationsApiQuery = z.infer<
  typeof listConversationsApi.querystring
>

/** Message summarized beneath one listed conversation's title. */
export type ConversationPreview = z.infer<typeof conversationPreviewSchema>

/** One listed conversation without its system prompt or transcript. */
export type ConversationSummary = z.infer<typeof conversationSummarySchema>

/** One page of listed conversations and its continuation state. */
export type ListConversationsApiResponse = z.infer<
  typeof listConversationsApi.response
>

/** Status-specific payloads returned by the conversation list endpoint. */
export type ListConversationsApiReply = {
  /** One page of conversations in the documented order. */
  readonly 200: ListConversationsApiResponse
}

/** Fastify route type for the conversation list endpoint. */
export type ListConversationsApiRoute = {
  /** Validated search, continuation, and page-size parameters. */
  readonly Querystring: ListConversationsApiQuery
  /** Status-specific success payload. */
  readonly Reply: ListConversationsApiReply
}
