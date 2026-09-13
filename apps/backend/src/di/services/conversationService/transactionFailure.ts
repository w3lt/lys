import type { DatabaseSync } from "node:sqlite"

/**
 * Rolls back an active transaction without discarding its original failure.
 * @param database - Borrowed connection whose operation failed.
 * @param failure - Original query, validation, or persistence failure.
 * @returns Never returns; preserves the original failure or both failures in an aggregate.
 * @throws The original failure, or an AggregateError if rollback also fails.
 */
export function handleConversationTransactionFailure(
  database: DatabaseSync,
  failure: unknown
): never {
  try {
    if (database.isTransaction) database.exec("ROLLBACK")
  } catch (rollbackFailure) {
    throw new AggregateError(
      [failure, rollbackFailure],
      "Conversation operation and rollback both failed",
      { cause: rollbackFailure }
    )
  }
  throw failure
}
