import * as z from "zod"
import { listConversationsApi } from "@lys/protocol"
import type {
  ConversationPage,
  ListConversationsInput
} from "../../../modules/conversation/records"
import type { DatabaseStatementCompiler } from "../databaseTransactions"

/**
 * SQL predicate for the rows of `conversation_messages m` that are searched
 * and previewed: reply text and the person's own messages. A wake-up
 * message, which the backend writes, is neither searched nor previewed, like
 * reasoning and tool results.
 */
const LISTED_MESSAGE_SQL = `(m.role = 'text' OR (m.role = 'user' AND m.origin IS NULL))`

/**
 * Shared SQL predicate for the match count and pages; values are always
 * bound parameters. Only a main conversation matches, never a job, and only
 * by its title or by a message {@link LISTED_MESSAGE_SQL} selects.
 */
const MATCHING_CONVERSATION_SQL = `(c.parent_conversation_id IS NULL
  AND ($query = '' OR contains_search(c.title, $query)
    OR EXISTS (SELECT 1 FROM conversation_messages m
      WHERE m.conversation_id = c.id AND ${LISTED_MESSAGE_SQL}
        AND contains_search(m.content, $query))))`

/** Validates the two count aggregates read within the same page snapshot. */
const conversationCountsSchema = z.strictObject({
  storedCount: z.int().nonnegative(),
  matchCount: z.int().nonnegative()
})

/**
 * Reads a bounded summary page and both counts from one SQLite snapshot.
 * Only main conversations are listed and counted, never a job.
 * @param statements - Statement compilation lent to the caller's read transaction.
 * @param input - Normalized search text, where empty matches every main
 * conversation; the previous page's last row, or undefined for the first page;
 * and the inclusive page size, from one to
 * `MAXIMUM_CONVERSATION_LIST_PAGE_SIZE`.
 * @returns The validated page with full preview text, and whether more rows match.
 * A preview is the person's message or one text part of a reply, shown as
 * the reply's; reasoning, tool calls, and wake-up messages are never
 * previews.
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
    (SELECT count(*) FROM conversations WHERE parent_conversation_id IS NULL) AS storedCount,
    count(*) AS matchCount FROM conversations c WHERE ${MATCHING_CONVERSATION_SQL}`
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
      WHERE m.conversation_id = c.id AND ${LISTED_MESSAGE_SQL}
      ORDER BY contains_search(m.content, $query) DESC, m.created_at DESC,
        m.position DESC, m.id DESC LIMIT 1
    ) WHERE ${MATCHING_CONVERSATION_SQL}
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
