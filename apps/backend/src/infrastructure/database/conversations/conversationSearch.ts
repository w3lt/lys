import type { SQLOutputValue } from "node:sqlite"
import { hasSearchText } from "../../../utils/search"

/**
 * Implements literal, locale-independent Unicode case-insensitive matching for SQLite.
 * @param content - Stored text; a null title never matches.
 * @param query - Normalized search text bound by the caller.
 * @returns SQLite integer truth value of {@link hasSearchText}, which
 * uses JavaScript Unicode simple case folding.
 */
export function calculateConversationSearchMatch(
  content: SQLOutputValue,
  query: SQLOutputValue
): number {
  if (typeof content !== "string" || typeof query !== "string") return 0
  return hasSearchText(content, query) ? 1 : 0
}
