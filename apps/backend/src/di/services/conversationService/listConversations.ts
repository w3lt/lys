import type { DatabaseSync, SQLOutputValue } from "node:sqlite"
import * as z from "zod"
import {
  listConversationsApi,
  type ListConversationsApiResponse
} from "@lys/protocol"
import {
  createConversationListCursor,
  type ConversationListOptions
} from "./utils"

/** Shared SQL predicate for counts and pages; values are always bound parameters. */
const matchingConversationSql = `($query = '' OR contains_search(c.title, $query)
  OR EXISTS (SELECT 1 FROM conversation_messages m
    WHERE m.conversation_id = c.id AND contains_search(m.content, $query)))`

/** Validates the two count aggregates read within the same page snapshot. */
const conversationCountsSchema = z.strictObject({
  storedCount: z.int().nonnegative(),
  matchCount: z.int().nonnegative()
})

/**
 * Implements literal, locale-independent Unicode case-insensitive matching for SQLite.
 * @param content - Stored text; a null title never matches.
 * @param query - Normalized search text bound by the caller.
 * @returns SQLite integer truth value using JavaScript Unicode simple case folding.
 */
export function calculateConversationSearchMatch(
  content: SQLOutputValue,
  query: SQLOutputValue
): number {
  if (typeof content !== "string" || typeof query !== "string") return 0
  const literalQuery = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(literalQuery, "iu").test(content) ? 1 : 0
}

/**
 * Reads a bounded summary page and both counts from one SQLite snapshot.
 * @param database - Borrowed connection in a caller-owned read transaction.
 * @param options - Validated query, cursor binding, and page size.
 * @returns The strict history page with full preview text and an opaque continuation.
 * @throws If SQLite or stored-record validation fails.
 */
export function listConversations(
  database: DatabaseSync,
  options: ConversationListOptions
): ListConversationsApiResponse {
  const { query, cursor, limit } = options
  const counts = conversationCountsSchema.parse(
    database
      .prepare(
        `SELECT
    (SELECT count(*) FROM conversations) AS storedCount,
    count(*) AS matchCount FROM conversations c WHERE ${matchingConversationSql}`
      )
      .get({ query })
  )
  const rows = database
    .prepare(
      `SELECT c.id, c.title, c.created_at AS createdAt,
    c.updated_at AS updatedAt, p.role AS previewRole, p.content AS previewContent
    FROM conversations c LEFT JOIN conversation_messages p ON p.id = (
      SELECT m.id FROM conversation_messages m
      WHERE m.conversation_id = c.id AND m.content <> ''
      ORDER BY contains_search(m.content, $query) DESC, m.created_at DESC, m.id DESC LIMIT 1
    ) WHERE ${matchingConversationSql}
      AND ($updatedAt IS NULL OR c.updated_at < $updatedAt
        OR (c.updated_at = $updatedAt AND c.id < $id))
    ORDER BY c.updated_at DESC, c.id DESC LIMIT $limit`
    )
    .all({
      query,
      updatedAt: cursor?.updatedAt ?? null,
      id: cursor?.id ?? null,
      limit: limit + 1
    })
  const conversations = rows.slice(0, limit).map(buildConversationSummary)
  const page = listConversationsApi.response.parse({
    conversations,
    storedCount: counts.storedCount,
    matchCount: counts.matchCount,
    nextCursor: null
  })
  const lastConversation = page.conversations.at(-1)
  const nextCursor =
    rows.length > limit && lastConversation !== undefined
      ? createConversationListCursor(query, lastConversation)
      : null
  return { ...page, nextCursor }
}

/**
 * Projects SQLite summary columns without leaking the system prompt or raw aliases.
 * @param row - Untrusted summary row, validated by the complete page parser.
 * @returns The untrusted protocol projection ready for validation.
 */
function buildConversationSummary(row: Record<string, unknown>): unknown {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    preview:
      row.previewContent === null
        ? null
        : { role: row.previewRole, content: row.previewContent }
  }
}
