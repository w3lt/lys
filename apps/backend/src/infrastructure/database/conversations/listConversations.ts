import * as z from "zod"
import { listConversationsApi } from "@lys/protocol"
import type {
  ConversationPage,
  ListConversationsInput
} from "../../../modules/conversation/records"
import type { DatabaseStatementCompiler } from "../databaseTransactions"

/**
 * Shared SQL predicate for counts and pages; values are always bound
 * parameters. Only the person's messages and reply text count: reasoning and
 * tool results are not searched.
 */
const matchingConversationSql = `($query = '' OR contains_search(c.title, $query)
  OR EXISTS (SELECT 1 FROM conversation_messages m
    WHERE m.conversation_id = c.id AND m.role IN ('user', 'text')
      AND contains_search(m.content, $query)))`

/** Validates the two count aggregates read within the same page snapshot. */
const conversationCountsSchema = z.strictObject({
  storedCount: z.int().nonnegative(),
  matchCount: z.int().nonnegative()
})

/**
 * Reads a bounded summary page and both counts from one SQLite snapshot.
 * @param statements - Statement compilation lent to the caller's read transaction.
 * @param input - Normalized search text, where empty matches every
 * conversation; the previous page's last row, or undefined for the first page;
 * and the inclusive page size, from one to
 * `MAXIMUM_CONVERSATION_LIST_PAGE_SIZE`.
 * @returns The validated page with full preview text, and whether more rows match.
 * A preview is the person's message or one text part of a reply, shown as
 * the reply's; reasoning and tool calls are never previews.
 * @throws If SQLite or stored-record validation fails.
 * @remarks Requires the `contains_search` function on the connection.
 */
export function listConversations(
  statements: DatabaseStatementCompiler,
  input: ListConversationsInput
): ConversationPage {
  const { query, after, limit } = input
  const counts = conversationCountsSchema.parse(
    statements
      .getStatement(
        `SELECT
    (SELECT count(*) FROM conversations) AS storedCount,
    count(*) AS matchCount FROM conversations c WHERE ${matchingConversationSql}`
      )
      .get({ query })
  )
  const rows = statements
    .getStatement(
      `SELECT c.id, c.title, c.created_at AS createdAt, c.updated_at AS updatedAt,
    CASE p.role WHEN 'text' THEN 'assistant' ELSE p.role END AS previewRole,
    p.content AS previewContent
    FROM conversations c LEFT JOIN conversation_messages p ON p.id = (
      SELECT m.id FROM conversation_messages m
      WHERE m.conversation_id = c.id AND m.role IN ('user', 'text')
      ORDER BY contains_search(m.content, $query) DESC, m.created_at DESC,
        m.position DESC, m.id DESC LIMIT 1
    ) WHERE ${matchingConversationSql}
      AND ($updatedAt IS NULL OR c.updated_at < $updatedAt
        OR (c.updated_at = $updatedAt AND c.id < $id))
    ORDER BY c.updated_at DESC, c.id DESC LIMIT $limit`
    )
    .all({
      query,
      updatedAt: after?.updatedAt ?? null,
      id: after?.id ?? null,
      limit: limit + 1
    })
  const page = listConversationsApi.response.parse({
    conversations: rows.slice(0, limit).map(buildConversationSummary),
    storedCount: counts.storedCount,
    matchCount: counts.matchCount,
    nextCursor: null
  })
  return {
    conversations: page.conversations,
    storedCount: page.storedCount,
    matchCount: page.matchCount,
    hasMore: rows.length > limit
  }
}

/**
 * Projects SQLite summary columns without leaking the agent code or raw aliases.
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
