import type { DatabaseSync } from "node:sqlite"
import { v7 as uuidv7 } from "uuid"
import { handleTransactionFailure } from "./transactionFailure"

/**
 * One migration that needs more than SQL text, run on the connection inside
 * the migration transaction.
 *
 * @remarks It must be synchronous and must not end the transaction; a throw
 * rolls back every pending migration.
 */
type DatabaseMigrationStep = (database: DatabaseSync) => void

/**
 * Creates the version-9 message table beside the version-8 one and copies
 * every message into it, each reply without its text.
 *
 * @remarks Reply pieces are rows under their reply: `reasoning` and `text`
 * hold one stretch of a round's text, and `tool_call` one call, keyed by the
 * call's identifier, with the result text the model read in `content`. A
 * comparison with NULL makes a CHECK pass in SQLite, so every comparison on
 * a nullable column is guarded by `IS NOT NULL`.
 */
const CREATE_REPLY_PART_MESSAGES_SQL = `
  CREATE TABLE new_conversation_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL
      REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (
      role IN ('user', 'assistant', 'reasoning', 'text', 'tool_call')
    ),
    reply_id TEXT REFERENCES new_conversation_messages(id) ON DELETE CASCADE,
    position INTEGER,
    round INTEGER,
    model TEXT,
    content TEXT NOT NULL,
    status TEXT,
    finish_reason TEXT,
    tool_name TEXT,
    tool_arguments TEXT,
    source_numbers TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT,
    CHECK (
      (
        role IN ('user', 'assistant')
        AND reply_id IS NULL
        AND position IS NULL
        AND round IS NULL
        AND tool_name IS NULL
        AND tool_arguments IS NULL
        AND source_numbers IS NULL
      )
      OR
      (
        role IN ('reasoning', 'text', 'tool_call')
        AND reply_id IS NOT NULL
        AND position IS NOT NULL
        AND position >= 0
        AND round IS NOT NULL
        AND round >= 0
        AND model IS NULL
        AND finish_reason IS NULL
        AND updated_at IS NOT NULL
      )
    ),
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
        AND content = ''
        AND model IS NOT NULL
        AND length(model) > 0
        AND status IS NOT NULL
        AND updated_at IS NOT NULL
        AND (
          (
            status = 'completed'
            AND finish_reason IS NOT NULL
            AND finish_reason IN ('stop', 'length')
          )
          OR
          (
            status IN ('streaming', 'interrupted', 'failed')
            AND finish_reason IS NULL
          )
        )
      )
      OR
      (
        role IN ('reasoning', 'text')
        AND length(content) > 0
        AND status IS NULL
        AND tool_name IS NULL
        AND tool_arguments IS NULL
        AND source_numbers IS NULL
      )
      OR
      (
        role = 'tool_call'
        AND tool_name IS NOT NULL
        AND tool_arguments IS NOT NULL
        AND status IS NOT NULL
        AND (source_numbers IS NULL OR json_valid(source_numbers))
        AND (
          (
            status IN ('awaiting-approval', 'running', 'interrupted')
            AND content = ''
            AND source_numbers IS NULL
          )
          OR status = 'succeeded'
          OR
          (
            status IN ('failed', 'rejected')
            AND length(content) > 0
            AND source_numbers IS NULL
          )
        )
      )
    )
  ) STRICT;

  INSERT INTO new_conversation_messages
    (id, conversation_id, role, model, content, status, finish_reason, created_at, updated_at)
  SELECT id, conversation_id, role, model,
    CASE role WHEN 'assistant' THEN '' ELSE content END,
    status, finish_reason, created_at, updated_at
  FROM conversation_messages;
`

/**
 * Replaces the version-8 message table with the version-9 one and creates
 * its index, triggers, and the sources table.
 *
 * @remarks The two triggers keep their version-5 meaning: a new row, a reply
 * piece included, moves its conversation's activity time forward, and so
 * does a change of a row's `content`; a status-only change does not.
 */
const REPLACE_MESSAGES_WITH_REPLY_PARTS_SQL = `
  DROP TABLE conversation_messages;
  ALTER TABLE new_conversation_messages RENAME TO conversation_messages;

  CREATE INDEX conversation_messages_conversation_idx
    ON conversation_messages (conversation_id, created_at, id);

  CREATE UNIQUE INDEX conversation_messages_reply_part_idx
    ON conversation_messages (reply_id, position)
    WHERE reply_id IS NOT NULL;

  CREATE TRIGGER update_conversation_after_message_insert
  AFTER INSERT ON conversation_messages
  FOR EACH ROW
  BEGIN
    UPDATE conversations
    SET updated_at = NEW.created_at
    WHERE id = NEW.conversation_id;
  END;

  CREATE TRIGGER update_conversation_after_message_update
  AFTER UPDATE OF content ON conversation_messages
  FOR EACH ROW
  BEGIN
    UPDATE conversations
    SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = NEW.conversation_id;
  END;

  CREATE TABLE conversation_sources (
    conversation_id TEXT NOT NULL
      REFERENCES conversations(id) ON DELETE CASCADE,
    number INTEGER NOT NULL CHECK (number >= 1),
    url TEXT NOT NULL CHECK (url <> ''),
    title TEXT NOT NULL CHECK (title <> ''),
    PRIMARY KEY (conversation_id, number),
    UNIQUE (conversation_id, url)
  ) STRICT;
`

/**
 * Moves every stored reply's text into one text piece under it.
 *
 * @param database - Connection inside the migration transaction, holding the
 * version-8 table and the copied version-9 rows.
 * @remarks Every reply stored before version 9 is plain text: the text of
 * all its rounds, joined by blank lines. That text becomes one `text` piece
 * at position 0 of round 0, with the reply's own creation and update times,
 * under a new UUIDv7 whose time is the reply's creation time. A reply without
 * text gets no piece. The new identities are made here, so a migration that
 * fails and runs again makes new ones; nothing outside the transaction has
 * seen the first ones.
 */
function createReplyTextParts(database: DatabaseSync): void {
  const replies = database
    .prepare(
      `SELECT id, conversation_id AS conversationId, content,
      created_at AS createdAt, updated_at AS updatedAt
      FROM conversation_messages WHERE role = 'assistant' AND content <> ''`
    )
    .all()
  const insertTextPart = database.prepare(
    `INSERT INTO new_conversation_messages
    (id, conversation_id, role, reply_id, position, round, content, created_at, updated_at)
    VALUES (?, ?, 'text', ?, 0, 0, ?, ?, ?)`
  )
  for (const reply of replies) {
    const { id, conversationId, content, createdAt, updatedAt } =
      parseVersion8ReplyText(reply)
    const partId = uuidv7({ msecs: Date.parse(createdAt) })
    insertTextPart.run(
      partId,
      conversationId,
      id,
      content,
      createdAt,
      updatedAt
    )
  }
}

/** A version-8 reply's text and the columns its text piece copies. */
type Version8ReplyText = Readonly<{
  /** Identity of the reply. */
  id: string
  /** Identity of the reply's conversation. */
  conversationId: string
  /** Non-empty text of every round of the reply. */
  content: string
  /** Creation time of the reply. */
  createdAt: string
  /** Last update time of the reply. */
  updatedAt: string
}>

/**
 * Reads one version-8 reply row selected for its text.
 *
 * @param row - Row with the reply's identity, conversation, text, and
 * times.
 * @returns The row's values.
 * @throws If a value is not text; the version-8 table stores only text in
 * these columns, so the row is corrupt.
 */
function parseVersion8ReplyText(
  row: Record<string, unknown>
): Version8ReplyText {
  const { id, conversationId, content, createdAt, updatedAt } = row
  if (
    typeof id !== "string" ||
    typeof conversationId !== "string" ||
    typeof content !== "string"
  )
    throw new Error("A stored reply has a value that is not text")
  if (typeof createdAt !== "string" || typeof updatedAt !== "string")
    throw new Error(`Stored reply ${id} has a time that is not text`)
  return { id, conversationId, content, createdAt, updatedAt }
}

/**
 * Stores each reply as its own row plus a row per piece, and adds the
 * conversation sources.
 *
 * @param database - Connection inside the migration transaction.
 * @remarks Version 9. SQLite cannot change a table's CHECK constraints, so
 * the message table is rebuilt: a new table with the new columns and rules
 * receives every message, each reply's text moves into a text piece, and the
 * new table replaces the old one together with its index and triggers.
 * Nothing references the message table from outside, so the rebuild needs no
 * foreign-key pause. Every message keeps its identity, times, and order;
 * only reply text changes rows. Builds that support only version 8 refuse
 * the result, and it cannot be turned back.
 */
function migrateRepliesToParts(database: DatabaseSync): void {
  database.exec(CREATE_REPLY_PART_MESSAGES_SQL)
  createReplyTextParts(database)
  database.exec(REPLACE_MESSAGES_WITH_REPLY_PARTS_SQL)
}

/**
 * Ordered SQLite schema migrations for the backend database.
 *
 * @remarks Each entry advances `PRAGMA user_version` by one and is applied
 * inside the transaction opened by {@link migrateDatabase}: SQL text is
 * executed as it is, and a step runs on the connection. Later migrations
 * depend on the schema established by earlier entries. The file has one
 * `user_version`, so every store's tables share this one list; a new table is
 * a new final entry.
 */
const databaseMigrations: readonly (string | DatabaseMigrationStep)[] = [
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


  `,
  `
    DROP TRIGGER update_conversation_after_message_update;
    CREATE TRIGGER update_conversation_after_message_update
    AFTER UPDATE OF content ON conversation_messages
    FOR EACH ROW
    BEGIN
      UPDATE conversations
      SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = NEW.conversation_id;
    END;
  `,
  // Stores agent definitions. SQLite checks only that every column is present
  // and that the code, name, bio, and system prompt are not empty; comparing
  // with '' counts every byte, where length() would stop at a NUL character.
  // The agent schemas check the code format, length limits, trimmed and
  // well-formed text, and timestamp format of every row the backend writes and
  // reads, so those rules can change without rebuilding this table.
  `
    CREATE TABLE agents (
      code TEXT NOT NULL PRIMARY KEY CHECK (code <> ''),
      name TEXT NOT NULL CHECK (name <> ''),
      bio TEXT NOT NULL CHECK (bio <> ''),
      system_prompt TEXT NOT NULL CHECK (system_prompt <> ''),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT
  `,
  // Replaces each conversation's stored system prompt with the code of the
  // agent that answers it; every turn sends that agent's current prompt.
  // Every conversation stored before this version was answered by Lys, the
  // only agent chats could use, so existing rows get `lys`. SQLite requires a
  // default to add a NOT NULL column; the backend always writes the code.
  // Dropping system_prompt discards the prompt text stored with each
  // conversation, and it cannot be recovered.
  `
    ALTER TABLE conversations
      ADD COLUMN agent_code TEXT NOT NULL DEFAULT 'lys' CHECK (agent_code <> '');
    ALTER TABLE conversations DROP COLUMN system_prompt;
  `,
  // Moves every conversation answered by Lys to Caliginia. Lys, under the
  // code `lys`, was the one built-in agent and the only agent chats could
  // use, so each of those conversations was hers; she is now shipped as two
  // built-in agents, and Caliginia is the one new conversations start with.
  // Nothing else changes: titles, times, and messages stay, a conversation
  // under any other code keeps it, and an agent stored under `lys` is the
  // person's own and stays theirs. The column default of version 7 still
  // reads `lys`; the backend always writes the code, so it is never used.
  `
    UPDATE conversations SET agent_code = 'caliginia' WHERE agent_code = 'lys';
  `,
  migrateRepliesToParts
]

/** Latest schema version that the backend database can open and migrate. */
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
 * @throws If the stored version is unsupported or any migration fails; an
 * active transaction is rolled back before the failure propagates. A version
 * newer than the supported one is rejected with a message naming both
 * versions.
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

      if (typeof migration === "string") database.exec(migration)
      else migration(database)
      database.exec(`PRAGMA user_version = ${migrationVersion}`)
    }

    database.exec("COMMIT")
  } catch (error) {
    handleTransactionFailure(database, error)
  }
}
