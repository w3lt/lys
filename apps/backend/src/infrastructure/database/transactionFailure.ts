import type { DatabaseSync } from "node:sqlite"
import { updateDatabaseWriteProtection } from "./writeProtection"

/**
 * Ends failed transaction work without discarding its original failure: rolls
 * back an active transaction and makes the connection refuse changes again.
 *
 * @param database - Connection whose transaction work failed.
 * @param failure - Original begin, statement, validation, or commit failure.
 * @returns Never returns; preserves the original failure or every failure in
 * an aggregate.
 * @throws The original failure once no transaction is active and write
 * protection is on.
 * @throws An `AggregateError` with the message
 * `Database operation and cleanup both failed`, holding the original failure
 * followed by the rollback failure and then the write-protection failure, for
 * whichever of those failed.
 * @remarks Write protection is restored even when the rollback fails.
 */
export function handleTransactionFailure(
  database: DatabaseSync,
  failure: unknown
): never {
  const cleanupFailures: unknown[] = []
  try {
    if (database.isTransaction) database.exec("ROLLBACK")
  } catch (rollbackError) {
    cleanupFailures.push(rollbackError)
  }
  try {
    updateDatabaseWriteProtection(database)
  } catch (protectionError) {
    cleanupFailures.push(protectionError)
  }
  if (cleanupFailures.length === 0) throw failure
  throw new AggregateError(
    [failure, ...cleanupFailures],
    "Database operation and cleanup both failed"
  )
}
