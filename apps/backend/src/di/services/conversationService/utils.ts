import * as z from "zod"
import {
  listConversationsApi,
  type ListConversationsApiQuery,
  type ConversationSummary
} from "@lys/protocol"

/** Version-one cursor binding a normalized query to an exact activity boundary. */
const conversationListCursorSchema = z.strictObject({
  version: z.literal(1),
  query: z.string(),
  score: z.null(),
  updatedAt: z.iso.datetime({ precision: 3 }),
  id: z.uuidv7()
})

/** Service-owned page size used only when a caller omits the bounded API limit. */
const DEFAULT_CONVERSATION_LIST_LIMIT = 30

/** Trusted cursor-bound query and page size supplied to SQLite. */
export type ConversationListOptions = Readonly<{
  /** Normalized query; empty only when the query parameter was omitted. */
  query: string
  /** Validated boundary, absent for the first page. */
  cursor: z.infer<typeof conversationListCursorSchema> | undefined
  /** Inclusive page size bounded by the shared API schema. */
  limit: number
}>

/**
 * Validates pagination input and binds decoded cursors to the normalized query.
 * @param options - Raw optional API query values.
 * @returns Trusted query and pagination options.
 * @throws If the input or cursor is malformed, unsupported, or belongs to another query.
 */
function parseConversationListInput(
  options: ListConversationsApiQuery
): ConversationListOptions {
  const parsed = listConversationsApi.querystring.parse(options)
  const query = parsed.query ?? ""
  if (parsed.cursor === undefined)
    return {
      query,
      cursor: undefined,
      limit: parsed.limit ?? DEFAULT_CONVERSATION_LIST_LIMIT
    }
  const decoded = Buffer.from(parsed.cursor, "base64")
  if (decoded.toString("base64") !== parsed.cursor)
    throw new Error("Invalid conversation list cursor")
  const cursor = conversationListCursorSchema.parse(
    JSON.parse(decoded.toString("utf8"))
  )
  if (cursor.query !== query)
    throw new Error("Conversation list cursor belongs to another query")
  return {
    query,
    cursor,
    limit: parsed.limit ?? DEFAULT_CONVERSATION_LIST_LIMIT
  }
}

/**
 * Creates a versioned opaque continuation from the last returned row.
 * @param query - Normalized query bound to the page.
 * @param conversation - Last row of a nonterminal page.
 * @returns Base64 JSON accepted only with the same query.
 */
export function createConversationListCursor(
  query: string,
  conversation: ConversationSummary
): string {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      query,
      score: null,
      updatedAt: conversation.updatedAt,
      id: conversation.id
    }),
    "utf8"
  ).toString("base64")
}

/** Invalid pagination input mapped by Fastify to a caller-safe HTTP 400. */
class ConversationListInputError extends Error {
  /**
   * Preserves the parser failure for server diagnostics.
   * @param cause - Original invalid query or cursor failure.
   */
  constructor(cause: unknown) {
    super("Invalid conversation list query or cursor", { cause })
  }
  /** HTTP status consumed by Fastify's error boundary. @returns The invalid-input status. */
  get statusCode(): number {
    return 400
  }
}

/**
 * Translates only pagination parsing failures into the public invalid-input category.
 * @param options - Raw optional query values.
 * @returns Validated options for one SQLite query.
 * @throws ConversationListInputError when any input or cursor binding is invalid.
 */
export function parseConversationListOptions(
  options: ListConversationsApiQuery = {}
): ConversationListOptions {
  try {
    return parseConversationListInput(options)
  } catch (cause) {
    throw new ConversationListInputError(cause)
  }
}
