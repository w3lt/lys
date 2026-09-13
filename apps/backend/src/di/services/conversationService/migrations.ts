import type { DatabaseSync } from "node:sqlite"
import { handleConversationTransactionFailure } from "./transactionFailure"

/**
 * Ordered SQLite schema migrations for the conversation store.
 *
 * @remarks Each entry advances `PRAGMA user_version` by one and is applied
 * inside the transaction opened by {@link migrateDatabase}. Later migrations
 * depend on the schema established by earlier entries.
 */
const databaseMigrations = [
  `
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      system_prompt TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT
  `,
  `
    CREATE TABLE conversation_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL
        REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      model TEXT,
      content TEXT NOT NULL,
      status TEXT CHECK (
        status IN ('streaming', 'completed', 'interrupted', 'failed')
      ),
      finish_reason TEXT CHECK (
        finish_reason IN ('stop', 'length')
      ),
      created_at TEXT NOT NULL,
      updated_at TEXT,
      CHECK (
        (
          role = 'user'
          AND model IS NULL
          AND length(content) > 0
          AND status IS NULL
          AND finish_reason IS NULL
          AND updated_at IS NULL
        )
        OR
        (
          role = 'assistant'
          AND status IS NOT NULL
          AND updated_at IS NOT NULL
          AND model IS NOT NULL
          AND length(model) > 0
          AND (
            (
              status = 'completed'
              AND finish_reason IS NOT NULL
            )
            OR
            (
              status IN ('streaming', 'interrupted', 'failed')
              AND finish_reason IS NULL
            )
          )
        )
      )
    ) STRICT;

    CREATE INDEX conversation_messages_conversation_idx
      ON conversation_messages (conversation_id, created_at, id);

    CREATE TRIGGER update_conversation_after_message_insert
    AFTER INSERT ON conversation_messages
    FOR EACH ROW
    BEGIN
      UPDATE conversations
      SET updated_at = NEW.created_at
      WHERE id = NEW.conversation_id;
    END;
  `,
  `
    CREATE TRIGGER update_conversation_updated_at
    AFTER UPDATE ON conversations
    FOR EACH ROW
    WHEN NEW.updated_at <= OLD.updated_at
    BEGIN
      UPDATE conversations
      SET updated_at = CASE
        WHEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') > OLD.updated_at
          THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        ELSE strftime(
          '%Y-%m-%dT%H:%M:%fZ',
          OLD.updated_at,
          '+0.001 seconds'
        )
      END
      WHERE id = NEW.id;
    END;

    CREATE TRIGGER update_conversation_after_message_update
    AFTER UPDATE ON conversation_messages
    FOR EACH ROW
    BEGIN
      UPDATE conversations
      SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = NEW.conversation_id;
    END;
  `,
  `
    DROP TRIGGER update_conversation_updated_at;
    CREATE TRIGGER update_conversation_updated_at
    AFTER UPDATE OF updated_at ON conversations
    FOR EACH ROW
    WHEN NEW.updated_at <= OLD.updated_at
    BEGIN
      UPDATE conversations
      SET updated_at = CASE
        WHEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') > OLD.updated_at
          THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        ELSE strftime(
          '%Y-%m-%dT%H:%M:%fZ',
          OLD.updated_at,
          '+0.001 seconds'
        )
      END
      WHERE id = NEW.id;
    END;


  `
] as const

/** Latest schema version that this service can open and migrate. */
const currentDatabaseVersion = databaseMigrations.length

/**
 * Reads and validates the SQLite schema version marker.
 *
 * @param database - Open SQLite database whose `user_version` is inspected.
 * @returns The non-negative safe-integer schema version.
 * @throws If SQLite returns a missing, non-integer, unsafe, or negative version.
 */
function readDatabaseVersion(database: DatabaseSync): number {
  const databaseVersion = database
    .prepare("PRAGMA user_version")
    .get()?.user_version

  if (
    typeof databaseVersion !== "number" ||
    !Number.isSafeInteger(databaseVersion) ||
    databaseVersion < 0
  ) {
    throw new Error("Invalid database user_version")
  }

  return databaseVersion
}

/**
 * Applies all pending schema migrations atomically in version order.
 *
 * @param database - Open SQLite database whose schema is migrated in place.
 * @throws If the stored version is unsupported or any migration fails; an active transaction is rolled back before the failure propagates.
 */
export function migrateDatabase(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE")

  try {
    const databaseVersion = readDatabaseVersion(database)

    if (databaseVersion > currentDatabaseVersion) {
      throw new Error(
        `Database version ${databaseVersion} is newer than supported version ${currentDatabaseVersion}`
      )
    }

    for (const [migrationIndex, migration] of databaseMigrations.entries()) {
      const migrationVersion = migrationIndex + 1

      if (migrationVersion <= databaseVersion) {
        continue
      }

      database.exec(migration)
      database.exec(`PRAGMA user_version = ${migrationVersion}`)
    }

    database.exec("COMMIT")
  } catch (error) {
    handleConversationTransactionFailure(database, error)
  }
}
