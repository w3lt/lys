import type { SQLOutputValue } from "node:sqlite"
import { hasSearchText, isExactSearchMatch } from "../../utils/search"
import type { DatabaseFunctionRegistry } from "./databaseTransactions"

/**
 * Implements `contains_search(content, query)`: literal, locale-independent
 * Unicode case-insensitive substring matching for SQLite.
 * @param content - Stored text; a value that is not text, such as a null
 * column, never matches.
 * @param query - Normalized search text bound by the caller.
 * @returns SQLite integer truth value of {@link hasSearchText}, which
 * uses JavaScript Unicode simple case folding.
 */
export function calculateSearchMatch(
  content: SQLOutputValue,
  query: SQLOutputValue
): number {
  if (typeof content !== "string" || typeof query !== "string") return 0
  return hasSearchText(content, query) ? 1 : 0
}

/**
 * Implements `equals_search(content, query)`: literal, locale-independent
 * Unicode case-insensitive equality for SQLite.
 * @param content - Stored text, compared whole, NUL characters included; a
 * value that is not text, such as a null column, never matches.
 * @param query - Normalized search text bound by the caller.
 * @returns SQLite integer truth value of {@link isExactSearchMatch}, which
 * uses JavaScript Unicode simple case folding.
 */
export function calculateExactSearchMatch(
  content: SQLOutputValue,
  query: SQLOutputValue
): number {
  if (typeof content !== "string" || typeof query !== "string") return 0
  return isExactSearchMatch(content, query) ? 1 : 0
}

/**
 * Registers the search functions the stores' queries use on the shared
 * connection.
 * @param registry - Function registration lent by the database owner.
 * @throws If the database is closed or SQLite rejects a registration.
 * @remarks Registers `contains_search` ({@link calculateSearchMatch}) and
 * `equals_search` ({@link calculateExactSearchMatch}), replacing functions
 * already registered under those names. Every store registers its search
 * functions through this one place, so a store created later never replaces
 * them with a different implementation.
 */
export function registerSearchFunctions(
  registry: DatabaseFunctionRegistry
): void {
  registry.registerDatabaseFunction("contains_search", calculateSearchMatch)
  registry.registerDatabaseFunction("equals_search", calculateExactSearchMatch)
}
