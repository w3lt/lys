import type { DatabaseSync } from "node:sqlite"

/**
 * SQLite pragma that makes a connection refuse every change while it is on.
 *
 * @remarks SQLite reports the pragma name to the authorizer as written, so a
 * comparison against it ignores case.
 */
export const WRITE_PROTECTION_PRAGMA = "query_only"

/** Makes the connection accept changes, for the duration of one write. */
export const DATABASE_WRITE_ACCESS_SQL =
  `PRAGMA ${WRITE_PROTECTION_PRAGMA} = OFF` as const

/** Makes the connection refuse every change again. */
export const DATABASE_WRITE_PROTECTION_SQL =
  `PRAGMA ${WRITE_PROTECTION_PRAGMA} = ON` as const

/**
 * Makes the connection refuse every change until its owner grants write
 * access again.
 *
 * @param database - Open connection.
 * @throws If SQLite rejects the pragma.
 * @remarks While protection is on, any statement that would change the
 * database, including `BEGIN IMMEDIATE`, fails with `attempt to write a
 * readonly database`; reads, `COMMIT`, and `ROLLBACK` still run. The setting
 * belongs to this connection only and is not stored in the database file.
 */
export function updateDatabaseWriteProtection(database: DatabaseSync): void {
  database.exec(DATABASE_WRITE_PROTECTION_SQL)
}
