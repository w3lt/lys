import type { SQLOutputValue } from "node:sqlite"

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
  const literalQuery = query.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
  return new RegExp(literalQuery, "iu").test(content) ? 1 : 0
}
