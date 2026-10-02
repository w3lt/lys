import type { DatabaseSync } from "node:sqlite"

/**
 * Rolls back an active transaction without discarding its original failure.
 *
 * @param database - Connection whose transaction work failed.
 * @param failure - Original statement, validation, or commit failure.
 * @returns Never returns; preserves the original failure or both failures in
 * an aggregate.
 * @throws The original failure, or an `AggregateError` with the message
 * `Database operation and rollback both failed` holding the original failure
 * followed by the rollback failure if rollback also fails.
 */
export function handleTransactionFailure(
  database: DatabaseSync,
  failure: unknown
): never {
  try {
    if (database.isTransaction) database.exec("ROLLBACK")
  } catch (rollbackFailure) {
    throw new AggregateError(
      [failure, rollbackFailure],
      "Database operation and rollback both failed",
      { cause: rollbackFailure }
    )
  }
  throw failure
}
