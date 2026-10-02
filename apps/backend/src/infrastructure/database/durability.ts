import type { DatabaseSync } from "node:sqlite"

/**
 * Sets the backend database's journal and sync policy on its connection.
 *
 * @param database - Open connection, outside any transaction.
 * @throws If SQLite rejects either pragma.
 * @remarks Write-ahead logging lets each commit append to the `-wal` file
 * instead of rewriting and syncing a rollback journal, and readers do not
 * block the writer. `synchronous = NORMAL` syncs at checkpoints rather than on
 * every commit: an application crash loses no committed write, while a power
 * loss or operating-system crash can lose the most recent commits. The
 * database stays consistent, and turn persistence's startup recovery marks a
 * reply left streaming as interrupted. WAL mode is stored in the
 * database file, so the `-wal` and `-shm` files beside it are part of the
 * database. An in-memory database keeps its `memory` journal mode, and a
 * filesystem that cannot use WAL keeps its previous mode; both stay correct,
 * only without the speedup.
 */
export function updateDatabaseDurability(database: DatabaseSync): void {
  database.exec("PRAGMA journal_mode = WAL")
  database.exec("PRAGMA synchronous = NORMAL")
}
