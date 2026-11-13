import { DatabaseSync } from "node:sqlite"
import { describe, expect, it, onTestFinished } from "vitest"
import { migrateDatabase } from "../../../../src/infrastructure/database/migrations"

/** Schema version produced by the current migration list. */
const CURRENT_SCHEMA_VERSION = 12

/**
 * Opens an empty in-memory database owned by the current test.
 *
 * @returns An open connection closed when the test finishes.
 */
function openEmptyDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:")
  onTestFinished(() => {
    database.close()
  })
  return database
}

/**
 * Reads the stored schema version marker.
 *
 * @param database - Open connection.
 * @returns The `user_version` pragma value.
 */
function readUserVersion(database: DatabaseSync): unknown {
  return database.prepare("PRAGMA user_version").get()?.user_version
}

/**
 * Lists schema objects of one kind.
 *
 * @param database - Open connection.
 * @param type - SQLite schema object type.
 * @returns Object names in ascending order.
 */
function listSchemaObjects(
  database: DatabaseSync,
  type: "table" | "trigger" | "index"
): unknown[] {
  return database
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all(type)
    .map((row) => row.name)
}

/**
 * Lists a table's column names in declaration order.
 *
 * @param database - Open connection.
 * @param table - Table name.
 * @returns Column names.
 */
function listColumns(database: DatabaseSync, table: string): unknown[] {
  return database
    .prepare("SELECT name FROM pragma_table_info(?)")
    .all(table)
    .map((row) => row.name)
}

/**
 * Message table, index, and triggers as migrations 2 to 5 left them, the
 * shape every version from 5 to 8 stores.
 *
 * @remarks Copied from those migrations at version 8 (commit 216db37), so a
 * fixture built from it is the historical table, not the current one.
 */
const VERSION_8_MESSAGES_SQL = `
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

  CREATE TRIGGER update_conversation_after_message_update
  AFTER UPDATE OF content ON conversation_messages
  FOR EACH ROW
  BEGIN
    UPDATE conversations
    SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = NEW.conversation_id;
  END;
`

/**
 * Creates a database with the version-8 schema.
 *
 * @returns A connection at `user_version` 8, closed when the test finishes.
 * @remarks Starts from {@link createVersion10Database}, then replaces what
 * migrations 9 and 10 changed with the historical version-8 objects: the
 * attachments and sources tables go, and the message table, its index, and
 * its triggers come back as {@link VERSION_8_MESSAGES_SQL}. The other tables
 * are unchanged since version 8.
 */
function createVersion8Database(): DatabaseSync {
  const database = createVersion10Database()
  database.exec(`
    DROP TABLE conversation_attachments;
    DROP TABLE conversation_sources;
    DROP TABLE conversation_messages;
    ${VERSION_8_MESSAGES_SQL}
    PRAGMA user_version = 8
  `)
  return database
}

/**
 * Creates a database at version 9: the current schema without the
 * attachments table.
 *
 * @returns A connection at `user_version` 9, closed when the test finishes.
 * @remarks Migration 10 only adds the attachments table, so dropping it from
 * a version-10 database leaves exactly the version-9 schema.
 */
function createVersion9Database(): DatabaseSync {
  const database = createVersion10Database()
  database.exec(`
    DROP TABLE conversation_attachments;
    PRAGMA user_version = 9
  `)
  return database
}

/**
 * Creates a database at version 10: the version-11 schema without the agents'
 * deletion time.
 *
 * @returns A connection at `user_version` 10, closed when the test finishes.
 * @remarks Migration 11 only adds `agents.deleted_at`, so dropping that
 * column from a version-11 database leaves exactly the version-10 schema.
 */
function createVersion10Database(): DatabaseSync {
  const database = createVersion11Database()
  database.exec(`
    ALTER TABLE agents DROP COLUMN deleted_at;
    PRAGMA user_version = 10
  `)
  return database
}

/**
 * Creates a database at version 11: the current schema without jobs.
 *
 * @returns A connection at `user_version` 11, closed when the test finishes.
 * @remarks Migration 12 only adds: the job reports table, two columns and an
 * index on the conversations table, and two columns and an index on the
 * message table. Dropping them from a current database, the table and the
 * indexes before the columns they name, leaves exactly the version-11
 * schema.
 */
function createVersion11Database(): DatabaseSync {
  const database = openEmptyDatabase()
  migrateDatabase(database)
  database.exec(`
    DROP TABLE job_reports;
    DROP INDEX conversation_messages_job_call_idx;
    DROP INDEX conversations_job_number_idx;
    ALTER TABLE conversation_messages DROP COLUMN job_call_id;
    ALTER TABLE conversation_messages DROP COLUMN origin;
    ALTER TABLE conversations DROP COLUMN job_number;
    ALTER TABLE conversations DROP COLUMN parent_conversation_id;
    PRAGMA user_version = 11
  `)
  return database
}

/**
 * Creates a database with the version-6 conversations table.
 *
 * @returns A connection at `user_version` 6, closed when the test finishes.
 * @remarks Starts from {@link createVersion8Database} and reverses migration
 * 7, which changes only the conversations table: it drops `agent_code` and
 * adds `system_prompt` back. SQLite requires the re-added column to have a
 * default, which the version-6 table lacked; every case writes the column
 * explicitly, so the default is never used.
 */
function createVersion6Database(): DatabaseSync {
  const database = createVersion8Database()
  database.exec(`
    ALTER TABLE conversations DROP COLUMN agent_code;
    ALTER TABLE conversations ADD COLUMN system_prompt TEXT NOT NULL DEFAULT '';
    PRAGMA user_version = 6
  `)
  return database
}

/**
 * Creates a database with the version-7 schema.
 *
 * @returns A connection at `user_version` 7, closed when the test finishes.
 * @remarks Starts from {@link createVersion8Database} and resets the version
 * marker: migration 8 changes only rows, and an empty database has none to
 * change.
 */
function createVersion7Database(): DatabaseSync {
  const database = createVersion8Database()
  database.exec("PRAGMA user_version = 7")
  return database
}

/** Version-8 message columns, which version 9 keeps with the same meaning. */
const VERSION_8_MESSAGE_COLUMNS =
  "id, conversation_id, role, model, status, finish_reason, created_at, updated_at"

/**
 * Lists the user and assistant rows of the message table, which versions 8
 * and 9 store alike.
 *
 * @param database - Open connection at version 8 or later.
 * @param columns - Columns to read: the version-8 columns, with or without
 * `content`, which version 9 empties on replies.
 * @returns The rows in identity order.
 */
function listMessageRows(
  database: DatabaseSync,
  columns: "version-8" | "version-8 and content"
): unknown[] {
  const selected =
    columns === "version-8"
      ? VERSION_8_MESSAGE_COLUMNS
      : `${VERSION_8_MESSAGE_COLUMNS}, content`
  return database
    .prepare(
      `SELECT ${selected} FROM conversation_messages
      WHERE role IN ('user', 'assistant') ORDER BY id`
    )
    .all()
}

/**
 * Lists the reply pieces of the message table.
 *
 * @param database - Open connection at version 9.
 * @returns Each piece's identity, place, text, and times, in reply order.
 */
function listReplyPartRows(database: DatabaseSync): Record<string, unknown>[] {
  return database
    .prepare(
      `SELECT id, conversation_id AS conversationId, role, reply_id AS replyId,
      position, round, content, status, tool_name AS toolName,
      created_at AS createdAt, updated_at AS updatedAt
      FROM conversation_messages WHERE reply_id IS NOT NULL ORDER BY reply_id`
    )
    .all()
}

/**
 * Stores, in a version-8 database, one conversation with a user message and
 * a completed, a failed, and a streaming reply.
 *
 * @param database - Connection at `user_version` 8.
 * @remarks The completed reply holds two rounds' text joined by a blank
 * line, the failed one no text, and the streaming one partial text; each
 * reply's update time differs from its creation time.
 */
function saveVersion8Conversation(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO conversations (id, title, agent_code, created_at, updated_at)
    VALUES ('c1', 'Title', 'caliginia', '2026-01-01T00:00:00.000Z', '2026-01-09T00:00:00.000Z');
    INSERT INTO conversation_messages (id, conversation_id, role, model, content, status, finish_reason, created_at, updated_at)
    VALUES
      ('u1', 'c1', 'user', NULL, 'Hello', NULL, NULL, '2026-01-02T00:00:00.000Z', NULL),
      ('a1', 'c1', 'assistant', 'model', 'First round' || char(10) || char(10) || 'Answer', 'completed', 'stop', '2026-01-03T00:00:00.000Z', '2026-01-04T00:00:00.000Z'),
      ('a2', 'c1', 'assistant', 'model', '', 'failed', NULL, '2026-01-05T00:00:00.000Z', '2026-01-05T00:00:01.000Z'),
      ('a3', 'c1', 'assistant', 'model', 'Partial', 'streaming', NULL, '2026-01-06T00:00:00.000Z', '2026-01-06T00:00:02.000Z')
  `)
}

/**
 * Stores, in a version-11 database, one conversation with a user message
 * that has an attachment, a completed reply with one text piece, and a
 * source.
 *
 * @param database - Connection at `user_version` 11.
 */
function saveVersion11Conversation(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO conversations (id, title, agent_code, created_at, updated_at)
    VALUES ('c1', 'Title', 'caliginia', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO conversation_messages (id, conversation_id, role, content, created_at)
    VALUES ('u1', 'c1', 'user', 'Hello', '2026-01-02T00:00:00.000Z');
    INSERT INTO conversation_messages (id, conversation_id, role, model, content, status, finish_reason, created_at, updated_at)
    VALUES ('a1', 'c1', 'assistant', 'model', '', 'completed', 'stop', '2026-01-03T00:00:00.000Z', '2026-01-04T00:00:00.000Z');
    INSERT INTO conversation_messages (id, conversation_id, role, reply_id, position, round, content, created_at, updated_at)
    VALUES ('p1', 'c1', 'text', 'a1', 0, 0, 'Answer', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z');
    INSERT INTO conversation_attachments (conversation_id, message_id, number, name, kind, media_type, size_bytes, width, height)
    VALUES ('c1', 'u1', 1, 'Notes.md', 'text', NULL, 12, NULL, NULL);
    INSERT INTO conversation_sources (conversation_id, number, url, title)
    VALUES ('c1', 1, 'https://example.com/', 'Example')
  `)
}

/**
 * Lists the conversation, message, attachment, and source rows by their
 * version-11 columns.
 *
 * @param database - Open connection at version 11 or later.
 * @returns The rows of each table: conversations, messages, attachments, then
 * sources.
 */
function listVersion11Rows(database: DatabaseSync): unknown[][] {
  /**
   * Queries that read every version-11 column of the tables holding
   * conversations, messages, attachments, and sources; version 12 keeps each
   * column with the same meaning.
   */
  const version11RowQueries = [
    "SELECT id, title, created_at, updated_at, agent_code FROM conversations ORDER BY id",
    `SELECT id, conversation_id, role, reply_id, position, round, model, content,
    status, finish_reason, tool_name, tool_arguments, source_numbers, created_at,
    updated_at FROM conversation_messages ORDER BY id`,
    `SELECT conversation_id, message_id, number, name, kind, media_type,
    size_bytes, width, height FROM conversation_attachments ORDER BY number`,
    "SELECT conversation_id, number, url, title FROM conversation_sources ORDER BY number"
  ] as const

  return version11RowQueries.map((sql) => database.prepare(sql).all())
}

/**
 * Lists every schema object with the SQL that defines it.
 *
 * @param database - Open connection.
 * @returns Each table, index, and trigger by type and name, with its SQL
 * text; an index SQLite makes by itself has none.
 */
function listSchemaDefinitions(database: DatabaseSync): unknown[] {
  return database
    .prepare(
      "SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema ORDER BY type, name"
    )
    .all()
}

/**
 * Stores the main conversation `main` with the person's message `u1` and a
 * completed reply `a1` that holds the `delegate_work` call `call1`, and its
 * job `job1` with the job message `ju1` the call sent and the reply `ja1`.
 */
const JOB_FIXTURE_SQL = `
  INSERT INTO conversations (id, title, agent_code, created_at, updated_at)
  VALUES ('main', NULL, 'caliginia', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  INSERT INTO conversation_messages (id, conversation_id, role, content, created_at)
  VALUES ('u1', 'main', 'user', 'Collect information about moths', '2026-01-01T00:00:01.000Z');
  INSERT INTO conversation_messages (id, conversation_id, role, model, content, status, finish_reason, created_at, updated_at)
  VALUES ('a1', 'main', 'assistant', 'model', '', 'completed', 'stop', '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:02.000Z');
  INSERT INTO conversation_messages (id, conversation_id, role, reply_id, position, round, content, status, tool_name, tool_arguments, created_at, updated_at)
  VALUES ('call1', 'main', 'tool_call', 'a1', 0, 0, 'Job 1 started', 'succeeded', 'delegate_work', '{}', '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:02.000Z');
  INSERT INTO conversations (id, title, agent_code, created_at, updated_at, parent_conversation_id, job_number)
  VALUES ('job1', 'Find what moths eat', 'researcher', '2026-01-01T00:00:03.000Z', '2026-01-01T00:00:03.000Z', 'main', 1);
  INSERT INTO conversation_messages (id, conversation_id, role, content, created_at, origin, job_call_id)
  VALUES ('ju1', 'job1', 'user', 'Find what moths eat', '2026-01-01T00:00:03.000Z', 'delegator', 'call1');
  INSERT INTO conversation_messages (id, conversation_id, role, model, content, status, finish_reason, created_at, updated_at)
  VALUES ('ja1', 'job1', 'assistant', 'model', '', 'completed', 'stop', '2026-01-01T00:00:04.000Z', '2026-01-01T00:00:04.000Z')
`

/** Columns a job-report row is inserted with in the version-12 cases. */
const JOB_REPORT_COLUMNS =
  "id, job_conversation_id, reply_id, kind, title, content, source_numbers, created_at, delivered_message_id"

/**
 * Stores, after {@link JOB_FIXTURE_SQL}, the wake-up message `w1` of `main`
 * and the result report `r1` of the reply `ja1`, which that message
 * delivered.
 */
const DELIVERED_REPORT_FIXTURE_SQL = `
  INSERT INTO conversation_messages (id, conversation_id, role, content, created_at, origin)
  VALUES ('w1', 'main', 'user', 'Reports from your jobs arrived.', '2026-01-01T00:00:06.000Z', 'wake-up');
  INSERT INTO job_reports (${JOB_REPORT_COLUMNS})
  VALUES ('r1', 'job1', 'ja1', 'result', 'Find what moths eat', 'They eat wool', '[]', '2026-01-01T00:00:05.000Z', 'w1')
`

/**
 * Stores a second main conversation `other` and its job `job9`, numbered 1
 * like the job of `main`, with the reply `ja9` and its result report `r9`.
 */
const OTHER_JOB_FIXTURE_SQL = `
  INSERT INTO conversations (id, title, agent_code, created_at, updated_at, parent_conversation_id, job_number)
  VALUES
    ('other', NULL, 'caliginia', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z', NULL, NULL),
    ('job9', 'Count moths', 'researcher', '2026-01-02T00:00:01.000Z', '2026-01-02T00:00:01.000Z', 'other', 1);
  INSERT INTO conversation_messages (id, conversation_id, role, model, content, status, finish_reason, created_at, updated_at)
  VALUES ('ja9', 'job9', 'assistant', 'model', '', 'completed', 'stop', '2026-01-02T00:00:02.000Z', '2026-01-02T00:00:02.000Z');
  INSERT INTO job_reports (${JOB_REPORT_COLUMNS})
  VALUES ('r9', 'job9', 'ja9', 'result', 'Count moths', 'Many', '[]', '2026-01-02T00:00:03.000Z', NULL)
`

/**
 * Reads how many rows one table holds.
 *
 * @param database - Open connection.
 * @param table - Table name.
 * @returns The number of rows.
 */
function getRowCount(database: DatabaseSync, table: string): unknown {
  return database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count
}

/**
 * Lists the identities stored in one table.
 *
 * @param database - Open connection.
 * @param table - Table whose rows have an `id` column.
 * @returns The identities in ascending order.
 */
function listIds(database: DatabaseSync, table: string): unknown[] {
  return database
    .prepare(`SELECT id FROM ${table} ORDER BY id`)
    .all()
    .map((row) => row.id)
}

describe("migrateDatabase", () => {
  it("creates the current schema in an empty database", () => {
    const database = openEmptyDatabase()

    migrateDatabase(database)

    expect(readUserVersion(database)).toBe(CURRENT_SCHEMA_VERSION)
    expect(listSchemaObjects(database, "table")).toEqual([
      "agents",
      "conversation_attachments",
      "conversation_messages",
      "conversation_sources",
      "conversations",
      "job_reports"
    ])
    expect(listSchemaObjects(database, "trigger")).toEqual([
      "update_conversation_after_message_insert",
      "update_conversation_after_message_update",
      "update_conversation_updated_at"
    ])
    expect(listSchemaObjects(database, "index")).toEqual([
      "conversation_messages_conversation_idx",
      "conversation_messages_job_call_idx",
      "conversation_messages_reply_part_idx",
      "conversations_job_number_idx",
      "job_reports_delivered_idx",
      "job_reports_job_idx",
      "job_reports_reply_end_idx",
      "job_reports_reply_idx"
    ])
    expect(database.isTransaction).toBe(false)
  })

  it("leaves a current database unchanged when run again", () => {
    const database = openEmptyDatabase()
    migrateDatabase(database)
    database
      .prepare(
        `INSERT INTO conversations (id, title, agent_code, created_at, updated_at)
        VALUES ('kept', NULL, 'lys', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
      .run()

    migrateDatabase(database)

    expect(readUserVersion(database)).toBe(CURRENT_SCHEMA_VERSION)
    expect(database.prepare("SELECT id FROM conversations").all()).toEqual([
      { id: "kept" }
    ])
  })

  it("upgrades a version-5 database by adding the agents table and keeping its conversations", () => {
    const database = createVersion6Database()
    // Migration 6 only adds the agents table, so dropping it from a version-6
    // database leaves exactly the version-5 schema.
    database.exec("DROP TABLE agents; PRAGMA user_version = 5")
    database
      .prepare(
        `INSERT INTO conversations (id, title, system_prompt, created_at, updated_at)
        VALUES ('kept', 'Title', 'prompt', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
      .run()

    migrateDatabase(database)

    expect(readUserVersion(database)).toBe(CURRENT_SCHEMA_VERSION)
    expect(listSchemaObjects(database, "table")).toContain("agents")
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM agents").get()
    ).toEqual({ count: 0 })
    expect(
      database.prepare("SELECT id, title FROM conversations").all()
    ).toEqual([{ id: "kept", title: "Title" }])
  })

  it("upgrades a version-6 database by recording Caliginia as every conversation's agent and dropping the stored prompts", () => {
    const database = createVersion6Database()
    database
      .prepare(
        `INSERT INTO conversations (id, title, system_prompt, created_at, updated_at)
        VALUES ('kept', 'Title', 'Old prompt', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
      .run()
    database
      .prepare(
        `INSERT INTO conversation_messages (id, conversation_id, role, content, created_at)
        VALUES ('question', 'kept', 'user', 'Hello', '2026-01-02T00:00:00.000Z')`
      )
      .run()
    const conversationsBefore = database
      .prepare("SELECT id, title, created_at, updated_at FROM conversations")
      .all()
    const messagesBefore = listMessageRows(database, "version-8 and content")

    migrateDatabase(database)

    expect(readUserVersion(database)).toBe(CURRENT_SCHEMA_VERSION)
    expect(listColumns(database, "conversations")).toEqual([
      "id",
      "title",
      "created_at",
      "updated_at",
      "agent_code",
      "parent_conversation_id",
      "job_number"
    ])
    expect(
      database
        .prepare("SELECT id, title, created_at, updated_at FROM conversations")
        .all()
    ).toEqual(conversationsBefore)
    expect(
      database
        .prepare("SELECT agent_code AS agentCode FROM conversations")
        .all()
    ).toEqual([{ agentCode: "caliginia" }])
    expect(listMessageRows(database, "version-8 and content")).toEqual(
      messagesBefore
    )
  })

  it("upgrades a version-7 database by moving every conversation Lys answered to Caliginia and changing nothing else", () => {
    const database = createVersion7Database()
    database.exec(`
      INSERT INTO conversations (id, title, agent_code, created_at, updated_at)
      VALUES
        ('first', 'Title', 'lys', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        ('second', NULL, 'lys', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z'),
        ('other', NULL, 'web-researcher', '2026-01-05T00:00:00.000Z', '2026-01-05T00:00:00.000Z');
      INSERT INTO conversation_messages (id, conversation_id, role, content, created_at)
      VALUES ('question', 'first', 'user', 'Hello', '2026-01-02T00:00:00.000Z');
      INSERT INTO agents (code, name, bio, system_prompt, created_at, updated_at)
      VALUES ('lys', 'Mine', 'My own agent.', 'You are mine.', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `)
    const conversationsBefore = database
      .prepare(
        "SELECT id, title, created_at, updated_at FROM conversations ORDER BY id"
      )
      .all()
    const messagesBefore = listMessageRows(database, "version-8 and content")
    const agentsBefore = database.prepare("SELECT * FROM agents").all()

    migrateDatabase(database)

    expect(readUserVersion(database)).toBe(CURRENT_SCHEMA_VERSION)
    expect(
      database
        .prepare(
          "SELECT id, agent_code AS agentCode FROM conversations ORDER BY id"
        )
        .all()
    ).toEqual([
      { id: "first", agentCode: "caliginia" },
      { id: "other", agentCode: "web-researcher" },
      { id: "second", agentCode: "caliginia" }
    ])
    expect(
      database
        .prepare(
          "SELECT id, title, created_at, updated_at FROM conversations ORDER BY id"
        )
        .all()
    ).toEqual(conversationsBefore)
    expect(listMessageRows(database, "version-8 and content")).toEqual(
      messagesBefore
    )
    expect(database.prepare("SELECT * FROM agents").all()).toEqual(
      agentsBefore.map((row) => ({ ...row, deleted_at: null }))
    )
  })

  it("upgrades a version-8 database by keeping every message and its conversation's activity time, without reply text", () => {
    const database = createVersion8Database()
    saveVersion8Conversation(database)
    const activityTimeBefore = database
      .prepare("SELECT updated_at AS updatedAt FROM conversations")
      .get()
    const messagesBefore = listMessageRows(database, "version-8")

    migrateDatabase(database)

    expect(readUserVersion(database)).toBe(CURRENT_SCHEMA_VERSION)
    expect(listMessageRows(database, "version-8")).toEqual(messagesBefore)
    expect(
      database
        .prepare(
          `SELECT id, content FROM conversation_messages
          WHERE role IN ('user', 'assistant') ORDER BY id`
        )
        .all()
    ).toEqual([
      { id: "a1", content: "" },
      { id: "a2", content: "" },
      { id: "a3", content: "" },
      { id: "u1", content: "Hello" }
    ])
    expect(
      database
        .prepare("SELECT updated_at AS updatedAt FROM conversations")
        .get()
    ).toEqual(activityTimeBefore)
    expect(listSchemaObjects(database, "trigger")).toEqual([
      "update_conversation_after_message_insert",
      "update_conversation_after_message_update",
      "update_conversation_updated_at"
    ])
  })

  it("upgrades a version-8 database by moving each reply's text into one text piece of round 0 with the reply's times", () => {
    const database = createVersion8Database()
    saveVersion8Conversation(database)

    migrateDatabase(database)

    const parts = listReplyPartRows(database)
    expect(parts).toEqual([
      {
        id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7/),
        conversationId: "c1",
        role: "text",
        replyId: "a1",
        position: 0,
        round: 0,
        content: "First round\n\nAnswer",
        status: null,
        toolName: null,
        createdAt: "2026-01-03T00:00:00.000Z",
        updatedAt: "2026-01-04T00:00:00.000Z"
      },
      {
        id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7/),
        conversationId: "c1",
        role: "text",
        replyId: "a3",
        position: 0,
        round: 0,
        content: "Partial",
        status: null,
        toolName: null,
        createdAt: "2026-01-06T00:00:00.000Z",
        updatedAt: "2026-01-06T00:00:02.000Z"
      }
    ])
    // A UUIDv7 holds its time in its first 48 bits.
    const firstPartTime = Number.parseInt(
      String(parts[0]?.id).replaceAll("-", "").slice(0, 12),
      16
    )
    expect(firstPartTime).toBe(Date.parse("2026-01-03T00:00:00.000Z"))
  })

  it("upgrades a version-8 database holding a reply whose text starts with a NUL character", () => {
    const database = createVersion8Database()
    database.exec(`
      INSERT INTO conversations (id, title, agent_code, created_at, updated_at)
      VALUES ('c1', NULL, 'caliginia', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO conversation_messages (id, conversation_id, role, model, content, status, finish_reason, created_at, updated_at)
      VALUES ('a1', 'c1', 'assistant', 'model', char(0) || 'Hi', 'completed', 'stop', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
    `)

    migrateDatabase(database)

    expect(readUserVersion(database)).toBe(CURRENT_SCHEMA_VERSION)
    expect(
      database
        .prepare(
          "SELECT reply_id AS replyId, content FROM conversation_messages WHERE role = 'text'"
        )
        .all()
    ).toEqual([{ replyId: "a1", content: "\u0000Hi" }])
  })

  it("keeps a version-8 database unchanged when migration 9 fails", () => {
    const database = createVersion8Database()
    database.exec(`
      INSERT INTO conversations (id, title, agent_code, created_at, updated_at)
      VALUES ('c1', NULL, 'caliginia', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO conversation_messages (id, conversation_id, role, model, content, status, finish_reason, created_at, updated_at)
      VALUES ('a1', 'c1', 'assistant', 'model', 'Answer', 'completed', 'stop', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
      CREATE TABLE conversation_sources (id TEXT)
    `)

    expect(() => migrateDatabase(database)).toThrow(
      /table conversation_sources already exists/
    )

    expect(readUserVersion(database)).toBe(8)
    expect(listColumns(database, "conversation_messages")).toEqual([
      "id",
      "conversation_id",
      "role",
      "model",
      "content",
      "status",
      "finish_reason",
      "created_at",
      "updated_at"
    ])
    expect(
      database.prepare("SELECT content FROM conversation_messages").all()
    ).toEqual([{ content: "Answer" }])
    expect(database.isTransaction).toBe(false)
  })

  it.each([
    [
      "a reply holding text",
      {
        role: "'assistant'",
        replyId: "NULL",
        position: "NULL",
        round: "NULL",
        model: "'model'",
        status: "'completed'",
        finishReason: "'stop'"
      },
      /CHECK constraint failed/
    ],
    [
      "a completed reply without a finish reason",
      {
        role: "'assistant'",
        replyId: "NULL",
        position: "NULL",
        round: "NULL",
        model: "'model'",
        content: "''",
        status: "'completed'"
      },
      /CHECK constraint failed/
    ],
    [
      "an empty user message",
      {
        role: "'user'",
        replyId: "NULL",
        position: "NULL",
        round: "NULL",
        content: "''",
        updatedAt: "NULL"
      },
      /CHECK constraint failed/
    ],
    [
      "a text piece without its reply",
      { replyId: "NULL" },
      /CHECK constraint failed/
    ],
    ["an empty text piece", { content: "''" }, /CHECK constraint failed/],
    [
      "an empty reasoning piece",
      { role: "'reasoning'", content: "''" },
      /CHECK constraint failed/
    ],
    [
      "a piece with a negative position",
      { position: "-1" },
      /CHECK constraint failed/
    ],
    ["a piece without a round", { round: "NULL" }, /CHECK constraint failed/],
    [
      "a piece at a position its reply already uses",
      { position: "0" },
      /UNIQUE constraint failed: conversation_messages\.reply_id, conversation_messages\.position/
    ],
    [
      "a running call with a result",
      {
        role: "'tool_call'",
        content: "'result'",
        status: "'running'",
        toolName: "'read_page'",
        toolArguments: "'{}'"
      },
      /CHECK constraint failed/
    ],
    [
      "a failed call without a result",
      {
        role: "'tool_call'",
        content: "''",
        status: "'failed'",
        toolName: "'read_page'",
        toolArguments: "'{}'"
      },
      /CHECK constraint failed/
    ],
    [
      "a rejected call without a result",
      {
        role: "'tool_call'",
        content: "''",
        status: "'rejected'",
        toolName: "'read_page'",
        toolArguments: "'{}'"
      },
      /CHECK constraint failed/
    ],
    [
      "a call without a status",
      {
        role: "'tool_call'",
        content: "''",
        toolName: "'read_page'",
        toolArguments: "'{}'"
      },
      /CHECK constraint failed/
    ],
    [
      "a call with a reply status",
      {
        role: "'tool_call'",
        content: "''",
        status: "'streaming'",
        toolName: "'read_page'",
        toolArguments: "'{}'"
      },
      /CHECK constraint failed/
    ],
    [
      "a call without its tool name",
      {
        role: "'tool_call'",
        content: "''",
        status: "'running'",
        toolArguments: "'{}'"
      },
      /CHECK constraint failed/
    ],
    [
      "a succeeded call whose source numbers are not JSON",
      {
        role: "'tool_call'",
        content: "'result'",
        status: "'succeeded'",
        toolName: "'read_page'",
        toolArguments: "'{}'",
        sourceNumbers: "'[1'"
      },
      /CHECK constraint failed/
    ]
  ])("refuses %s", (_label, change, failure) => {
    const database = openEmptyDatabase()
    migrateDatabase(database)
    database.exec(`
      INSERT INTO conversations (id, title, agent_code, created_at, updated_at)
      VALUES ('c1', NULL, 'caliginia', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO conversation_messages (id, conversation_id, role, model, content, status, finish_reason, created_at, updated_at)
      VALUES ('a1', 'c1', 'assistant', 'model', '', 'streaming', NULL, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
      INSERT INTO conversation_messages (id, conversation_id, role, reply_id, position, round, content, created_at, updated_at)
      VALUES ('p1', 'c1', 'text', 'a1', 0, 0, 'kept', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
    `)
    // A valid text piece at position 1, with the case's one change.
    const row = {
      role: "'text'",
      replyId: "'a1'",
      position: "1",
      round: "0",
      model: "NULL",
      content: "'text'",
      status: "NULL",
      finishReason: "NULL",
      toolName: "NULL",
      toolArguments: "NULL",
      sourceNumbers: "NULL",
      updatedAt: "'2026-01-03T00:00:00.000Z'",
      ...change
    }

    expect(() =>
      database.exec(
        `INSERT INTO conversation_messages
        (id, conversation_id, role, reply_id, position, round, model, content, status, finish_reason, tool_name, tool_arguments, source_numbers, created_at, updated_at)
        VALUES ('p2', 'c1', ${row.role}, ${row.replyId}, ${row.position}, ${row.round}, ${row.model}, ${row.content}, ${row.status}, ${row.finishReason}, ${row.toolName}, ${row.toolArguments}, ${row.sourceNumbers}, '2026-01-03T00:00:00.000Z', ${row.updatedAt})`
      )
    ).toThrow(failure)
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM conversation_messages")
        .get()
    ).toEqual({ count: 2 })
  })

  it("stores each kind of reply piece the version-9 rules allow", () => {
    const database = openEmptyDatabase()
    migrateDatabase(database)

    database.exec(`
      INSERT INTO conversations (id, title, agent_code, created_at, updated_at)
      VALUES ('c1', NULL, 'caliginia', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO conversation_messages (id, conversation_id, role, model, content, status, finish_reason, created_at, updated_at)
      VALUES ('a1', 'c1', 'assistant', 'model', '', 'streaming', NULL, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
      INSERT INTO conversation_messages (id, conversation_id, role, reply_id, position, round, content, status, tool_name, tool_arguments, source_numbers, created_at, updated_at)
      VALUES
        ('p0', 'c1', 'reasoning', 'a1', 0, 0, 'Thinking', NULL, NULL, NULL, NULL, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
        ('p1', 'c1', 'text', 'a1', 1, 0, 'Let me look', NULL, NULL, NULL, NULL, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
        ('p2', 'c1', 'tool_call', 'a1', 2, 0, '', 'awaiting-approval', 'web_search', '{"query":"lys"}', NULL, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
        ('p3', 'c1', 'tool_call', 'a1', 3, 0, '', 'succeeded', 'read_text_file', '', NULL, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
        ('p4', 'c1', 'tool_call', 'a1', 4, 0, 'Results', 'succeeded', 'web_search', '{}', '[1,2]', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
        ('p5', 'c1', 'tool_call', 'a1', 5, 0, 'Rejected', 'rejected', '', 'not json', NULL, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
      INSERT INTO conversation_sources (conversation_id, number, url, title)
      VALUES ('c1', 1, 'https://example.com/', 'Example')
    `)

    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM conversation_messages WHERE reply_id = 'a1'"
        )
        .get()
    ).toEqual({ count: 6 })
  })

  it("deletes a reply's pieces with the reply, and a conversation's pieces and sources with the conversation", () => {
    const database = openEmptyDatabase()
    migrateDatabase(database)
    database.exec(`
      INSERT INTO conversations (id, title, agent_code, created_at, updated_at)
      VALUES ('c1', NULL, 'caliginia', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO conversation_messages (id, conversation_id, role, model, content, status, finish_reason, created_at, updated_at)
      VALUES
        ('a1', 'c1', 'assistant', 'model', '', 'completed', 'stop', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
        ('a2', 'c1', 'assistant', 'model', '', 'completed', 'stop', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z');
      INSERT INTO conversation_messages (id, conversation_id, role, reply_id, position, round, content, created_at, updated_at)
      VALUES
        ('p1', 'c1', 'text', 'a1', 0, 0, 'One', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
        ('p2', 'c1', 'text', 'a2', 0, 0, 'Two', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z');
      INSERT INTO conversation_sources (conversation_id, number, url, title)
      VALUES ('c1', 1, 'https://example.com/', 'Example')
    `)

    database.exec("DELETE FROM conversation_messages WHERE id = 'a1'")

    expect(
      database.prepare("SELECT id FROM conversation_messages ORDER BY id").all()
    ).toEqual([{ id: "a2" }, { id: "p2" }])

    database.exec("DELETE FROM conversations WHERE id = 'c1'")

    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM conversation_messages")
        .get()
    ).toEqual({ count: 0 })
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM conversation_sources")
        .get()
    ).toEqual({ count: 0 })
  })

  it("refuses a piece whose reply is not stored", () => {
    const database = openEmptyDatabase()
    migrateDatabase(database)
    database.exec(`
      INSERT INTO conversations (id, title, agent_code, created_at, updated_at)
      VALUES ('c1', NULL, 'caliginia', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `)

    expect(() =>
      database.exec(`
        INSERT INTO conversation_messages (id, conversation_id, role, reply_id, position, round, content, created_at, updated_at)
        VALUES ('p1', 'c1', 'text', 'missing', 0, 0, 'Text', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
      `)
    ).toThrow(/FOREIGN KEY constraint failed/)
  })

  it("moves a conversation's activity time forward when a piece is added or its content changes, and not when only its status changes", () => {
    const database = openEmptyDatabase()
    migrateDatabase(database)
    database.exec(`
      INSERT INTO conversations (id, title, agent_code, created_at, updated_at)
      VALUES ('c1', NULL, 'caliginia', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO conversation_messages (id, conversation_id, role, model, content, status, finish_reason, created_at, updated_at)
      VALUES ('a1', 'c1', 'assistant', 'model', '', 'streaming', NULL, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
    `)
    const readActivityTime = () =>
      database
        .prepare("SELECT updated_at AS updatedAt FROM conversations")
        .get()

    database.exec(`
      INSERT INTO conversation_messages (id, conversation_id, role, reply_id, position, round, content, status, tool_name, tool_arguments, created_at, updated_at)
      VALUES ('p1', 'c1', 'tool_call', 'a1', 0, 0, '', 'awaiting-approval', 'read_page', '{}', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z')
    `)
    expect(readActivityTime()).toEqual({
      updatedAt: "2026-01-03T00:00:00.000Z"
    })

    database.exec(
      "UPDATE conversation_messages SET status = 'running' WHERE id = 'p1'"
    )
    expect(readActivityTime()).toEqual({
      updatedAt: "2026-01-03T00:00:00.000Z"
    })

    database.exec(
      "UPDATE conversation_messages SET status = 'succeeded', content = 'Page' WHERE id = 'p1'"
    )
    expect(readActivityTime()).not.toEqual({
      updatedAt: "2026-01-03T00:00:00.000Z"
    })
  })

  it.each([
    ["a number below 1", "('c1', 0, 'https://example.com/a', 'A')"],
    ["an empty URL", "('c1', 2, '', 'A')"],
    ["an empty title", "('c1', 2, 'https://example.com/a', '')"],
    [
      "a number the conversation already uses",
      "('c1', 1, 'https://example.com/a', 'A')"
    ],
    [
      "a URL the conversation already stores",
      "('c1', 2, 'https://example.com/', 'A')"
    ]
  ])("refuses a source with %s", (_label, values) => {
    const database = openEmptyDatabase()
    migrateDatabase(database)
    database.exec(`
      INSERT INTO conversations (id, title, agent_code, created_at, updated_at)
      VALUES ('c1', NULL, 'caliginia', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO conversation_sources (conversation_id, number, url, title)
      VALUES ('c1', 1, 'https://example.com/', 'Example')
    `)

    expect(() =>
      database.exec(
        `INSERT INTO conversation_sources (conversation_id, number, url, title) VALUES ${values}`
      )
    ).toThrow(/constraint failed/)
  })

  it("refuses a conversation row with an empty agent code", () => {
    const database = openEmptyDatabase()
    migrateDatabase(database)

    expect(() =>
      database.exec(
        `INSERT INTO conversations (id, title, agent_code, created_at, updated_at)
        VALUES ('empty', NULL, '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
    ).toThrow(/CHECK constraint failed: agent_code <> ''/)
  })

  it.each([
    [
      "a missing code",
      { code: "NULL" },
      /NOT NULL constraint failed: agents\.code/
    ],
    ["an empty code", { code: "''" }, /CHECK constraint failed: code <> ''/],
    ["an empty name", { name: "''" }, /CHECK constraint failed: name <> ''/],
    ["an empty bio", { bio: "''" }, /CHECK constraint failed: bio <> ''/],
    [
      "an empty system prompt",
      { systemPrompt: "''" },
      /CHECK constraint failed: system_prompt <> ''/
    ]
  ])("refuses an agent row with %s", (_label, change, failure) => {
    const database = openEmptyDatabase()
    migrateDatabase(database)
    const row = {
      code: "'lys'",
      name: "'Lys'",
      bio: "'Bio'",
      systemPrompt: "'Prompt'",
      ...change
    }

    expect(() =>
      database.exec(
        `INSERT INTO agents (code, name, bio, system_prompt, created_at, updated_at)
        VALUES (${row.code}, ${row.name}, ${row.bio}, ${row.systemPrompt}, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
    ).toThrow(failure)
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM agents").get()
    ).toEqual({ count: 0 })
  })

  it("stores reply text, a user message, and a failed call's result that start with a NUL character", () => {
    const database = openEmptyDatabase()
    migrateDatabase(database)
    database.exec(`
      INSERT INTO conversations (id, title, agent_code, created_at, updated_at)
      VALUES ('c1', NULL, 'caliginia', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO conversation_messages (id, conversation_id, role, model, content, status, finish_reason, created_at, updated_at)
      VALUES
        ('u1', 'c1', 'user', NULL, char(0) || 'Hello', NULL, NULL, '2026-01-02T00:00:00.000Z', NULL),
        ('a1', 'c1', 'assistant', 'model', '', 'streaming', NULL, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
      INSERT INTO conversation_messages (id, conversation_id, role, reply_id, position, round, content, status, tool_name, tool_arguments, created_at, updated_at)
      VALUES
        ('p0', 'c1', 'reasoning', 'a1', 0, 0, char(0) || 'Thinking', NULL, NULL, NULL, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
        ('p1', 'c1', 'text', 'a1', 1, 0, char(0) || 'Answer', NULL, NULL, NULL, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
        ('p2', 'c1', 'tool_call', 'a1', 2, 0, char(0) || 'Failed', 'failed', 'read_page', '{}', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
    `)

    expect(
      database
        .prepare(
          "SELECT id, content FROM conversation_messages WHERE id <> 'a1' ORDER BY id"
        )
        .all()
    ).toEqual([
      { id: "p0", content: "\u0000Thinking" },
      { id: "p1", content: "\u0000Answer" },
      { id: "p2", content: "\u0000Failed" },
      { id: "u1", content: "\u0000Hello" }
    ])
  })

  it("stores agent text that starts with a NUL character", () => {
    const database = openEmptyDatabase()
    migrateDatabase(database)

    database
      .prepare(
        `INSERT INTO agents (code, name, bio, system_prompt, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        "lys",
        "\u0000Lys",
        "\u0000Bio",
        "\u0000Prompt",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z"
      )

    expect(
      database
        .prepare("SELECT name, bio, system_prompt AS systemPrompt FROM agents")
        .get()
    ).toEqual({
      name: "\u0000Lys",
      bio: "\u0000Bio",
      systemPrompt: "\u0000Prompt"
    })
  })

  it("upgrades a version-9 database by adding the attachments table and keeping its messages", () => {
    const database = createVersion9Database()
    database.exec(`
      INSERT INTO conversations (id, title, agent_code, created_at, updated_at)
      VALUES ('c1', NULL, 'caliginia', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO conversation_messages (id, conversation_id, role, content, created_at)
      VALUES ('u1', 'c1', 'user', 'Hello', '2026-01-02T00:00:00.000Z')
    `)

    migrateDatabase(database)

    expect(readUserVersion(database)).toBe(CURRENT_SCHEMA_VERSION)
    expect(listColumns(database, "conversation_attachments")).toEqual([
      "conversation_id",
      "message_id",
      "number",
      "name",
      "kind",
      "media_type",
      "size_bytes",
      "width",
      "height"
    ])
    expect(
      database.prepare("SELECT id, content FROM conversation_messages").all()
    ).toEqual([{ id: "u1", content: "Hello" }])
  })

  it("upgrades a version-10 database by adding the agents' deletion time, leaving every stored agent not deleted", () => {
    const database = createVersion10Database()
    database.exec(`
      INSERT INTO agents (code, name, bio, system_prompt, created_at, updated_at)
      VALUES ('researcher', 'Researcher', 'Searches.', 'You search.', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
    `)

    migrateDatabase(database)

    expect(readUserVersion(database)).toBe(CURRENT_SCHEMA_VERSION)
    expect(listColumns(database, "agents")).toEqual([
      "code",
      "name",
      "bio",
      "system_prompt",
      "created_at",
      "updated_at",
      "deleted_at"
    ])
    expect(
      database.prepare("SELECT code, updated_at, deleted_at FROM agents").all()
    ).toEqual([
      {
        code: "researcher",
        updated_at: "2026-01-02T00:00:00.000Z",
        deleted_at: null
      }
    ])
  })

  it("refuses an empty agent deletion time", () => {
    const database = openEmptyDatabase()
    migrateDatabase(database)

    expect(() =>
      database.exec(`
        INSERT INTO agents (code, name, bio, system_prompt, created_at, updated_at, deleted_at)
        VALUES ('researcher', 'Researcher', 'Searches.', 'You search.', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '')
      `)
    ).toThrow(/CHECK constraint failed/)
  })

  /** Stores a conversation with one user message for attachment cases. */
  const ATTACHMENT_PARENTS_SQL = `
    INSERT INTO conversations (id, title, agent_code, created_at, updated_at)
    VALUES ('c1', NULL, 'caliginia', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO conversation_messages (id, conversation_id, role, content, created_at)
    VALUES ('u1', 'c1', 'user', 'Hello', '2026-01-02T00:00:00.000Z');
    INSERT INTO conversation_attachments (conversation_id, message_id, number, name, kind, media_type, size_bytes, width, height)
    VALUES ('c1', 'u1', 1, 'Notes.md', 'text', NULL, 12, NULL, NULL)
  `

  it("stores an image and a text attachment under a user message", () => {
    const database = openEmptyDatabase()
    migrateDatabase(database)
    database.exec(ATTACHMENT_PARENTS_SQL)

    database.exec(`
      INSERT INTO conversation_attachments (conversation_id, message_id, number, name, kind, media_type, size_bytes, width, height)
      VALUES ('c1', 'u1', 2, 'photo.png', 'image', 'image/png', 2048, 64, 32)
    `)

    expect(
      database
        .prepare(
          "SELECT number, name, kind FROM conversation_attachments ORDER BY number"
        )
        .all()
    ).toEqual([
      { number: 1, name: "Notes.md", kind: "text" },
      { number: 2, name: "photo.png", kind: "image" }
    ])
  })

  it.each([
    [
      "a number below 1",
      "('c1', 'u1', 0, 'a.md', 'text', NULL, 1, NULL, NULL)"
    ],
    ["an empty name", "('c1', 'u1', 2, '', 'text', NULL, 1, NULL, NULL)"],
    ["the name .", "('c1', 'u1', 2, '.', 'text', NULL, 1, NULL, NULL)"],
    ["the name ..", "('c1', 'u1', 2, '..', 'text', NULL, 1, NULL, NULL)"],
    [
      "a name holding a slash",
      "('c1', 'u1', 2, 'a/b.md', 'text', NULL, 1, NULL, NULL)"
    ],
    [
      "an unknown kind",
      "('c1', 'u1', 2, 'a.pdf', 'document', NULL, 1, NULL, NULL)"
    ],
    [
      "a negative size",
      "('c1', 'u1', 2, 'a.md', 'text', NULL, -1, NULL, NULL)"
    ],
    [
      "an image without a media type",
      "('c1', 'u1', 2, 'a.png', 'image', NULL, 1, 64, 32)"
    ],
    [
      "an image without sides",
      "('c1', 'u1', 2, 'a.png', 'image', 'image/png', 1, NULL, NULL)"
    ],
    [
      "an image with a zero side",
      "('c1', 'u1', 2, 'a.png', 'image', 'image/png', 1, 0, 32)"
    ],
    [
      "a text file with sides",
      "('c1', 'u1', 2, 'a.md', 'text', NULL, 1, 64, 32)"
    ],
    [
      "a text file with a media type",
      "('c1', 'u1', 2, 'a.md', 'text', 'text/plain', 1, NULL, NULL)"
    ],
    [
      "a name the message already stores, in another case",
      "('c1', 'u1', 2, 'notes.MD', 'text', NULL, 1, NULL, NULL)"
    ],
    [
      "a number the conversation already uses",
      "('c1', 'u1', 1, 'other.md', 'text', NULL, 1, NULL, NULL)"
    ],
    [
      "a message that is not stored",
      "('c1', 'u9', 2, 'a.md', 'text', NULL, 1, NULL, NULL)"
    ]
  ])("refuses an attachment with %s", (_label, values) => {
    const database = openEmptyDatabase()
    migrateDatabase(database)
    database.exec(ATTACHMENT_PARENTS_SQL)

    expect(() =>
      database.exec(
        `INSERT INTO conversation_attachments (conversation_id, message_id, number, name, kind, media_type, size_bytes, width, height) VALUES ${values}`
      )
    ).toThrow(/constraint failed/)
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM conversation_attachments")
        .get()
    ).toEqual({ count: 1 })
  })

  it("deletes a message's attachments with the message, and a conversation's with the conversation", () => {
    const database = openEmptyDatabase()
    migrateDatabase(database)
    database.exec(ATTACHMENT_PARENTS_SQL)
    database.exec(`
      INSERT INTO conversation_messages (id, conversation_id, role, content, created_at)
      VALUES ('u2', 'c1', 'user', 'Again', '2026-01-03T00:00:00.000Z');
      INSERT INTO conversation_attachments (conversation_id, message_id, number, name, kind, media_type, size_bytes, width, height)
      VALUES ('c1', 'u2', 2, 'later.md', 'text', NULL, 3, NULL, NULL)
    `)

    database.exec("DELETE FROM conversation_messages WHERE id = 'u2'")
    expect(
      database.prepare("SELECT name FROM conversation_attachments").all()
    ).toEqual([{ name: "Notes.md" }])

    database.exec("DELETE FROM conversations WHERE id = 'c1'")
    expect(
      database.prepare("SELECT name FROM conversation_attachments").all()
    ).toEqual([])
  })

  it("upgrades a version-11 database by adding jobs and keeping every conversation, message, attachment, and source row", () => {
    const database = createVersion11Database()
    saveVersion11Conversation(database)
    const rowsBefore = listVersion11Rows(database)

    migrateDatabase(database)

    expect(readUserVersion(database)).toBe(CURRENT_SCHEMA_VERSION)
    expect(rowsBefore.map((rows) => rows.length)).toEqual([1, 3, 1, 1])
    expect(listVersion11Rows(database)).toEqual(rowsBefore)
    expect(listColumns(database, "job_reports")).toEqual([
      "id",
      "job_conversation_id",
      "reply_id",
      "kind",
      "title",
      "content",
      "source_numbers",
      "created_at",
      "delivered_message_id"
    ])
  })

  it("upgrades a version-11 database to the schema a new database gets", () => {
    const upgraded = createVersion11Database()
    const created = openEmptyDatabase()
    migrateDatabase(created)

    migrateDatabase(upgraded)

    expect(listSchemaDefinitions(upgraded)).toEqual(
      listSchemaDefinitions(created)
    )
  })

  it("gives every existing conversation no parent and no job number, and every existing message no origin and no job call", () => {
    const database = createVersion11Database()
    saveVersion11Conversation(database)

    migrateDatabase(database)

    expect(
      database
        .prepare(
          "SELECT id, parent_conversation_id, job_number FROM conversations"
        )
        .all()
    ).toEqual([{ id: "c1", parent_conversation_id: null, job_number: null }])
    expect(
      database
        .prepare(
          "SELECT id, origin, job_call_id FROM conversation_messages ORDER BY id"
        )
        .all()
    ).toEqual([
      { id: "a1", origin: null, job_call_id: null },
      { id: "p1", origin: null, job_call_id: null },
      { id: "u1", origin: null, job_call_id: null }
    ])
  })

  it("stores a job under its parent, a job message with the call that sent it, and a wake-up message with the report it delivered", () => {
    const database = openEmptyDatabase()
    migrateDatabase(database)

    database.exec(JOB_FIXTURE_SQL)
    database.exec(DELIVERED_REPORT_FIXTURE_SQL)

    expect(
      database
        .prepare(
          "SELECT id, parent_conversation_id, job_number FROM conversations ORDER BY id"
        )
        .all()
    ).toEqual([
      { id: "job1", parent_conversation_id: "main", job_number: 1 },
      { id: "main", parent_conversation_id: null, job_number: null }
    ])
    expect(
      database
        .prepare(
          "SELECT id, origin, job_call_id FROM conversation_messages WHERE role = 'user' ORDER BY id"
        )
        .all()
    ).toEqual([
      { id: "ju1", origin: "delegator", job_call_id: "call1" },
      { id: "u1", origin: null, job_call_id: null },
      { id: "w1", origin: "wake-up", job_call_id: null }
    ])
    expect(
      database.prepare("SELECT id, delivered_message_id FROM job_reports").all()
    ).toEqual([{ id: "r1", delivered_message_id: "w1" }])
  })

  it("numbers jobs within their parent, so two parents each store a job 1", () => {
    const database = openEmptyDatabase()
    migrateDatabase(database)
    database.exec(JOB_FIXTURE_SQL)

    database.exec(OTHER_JOB_FIXTURE_SQL)

    expect(
      database
        .prepare(
          "SELECT id, job_number FROM conversations WHERE job_number IS NOT NULL ORDER BY id"
        )
        .all()
    ).toEqual([
      { id: "job1", job_number: 1 },
      { id: "job9", job_number: 1 }
    ])
  })

  it.each([
    [
      "a job number and no parent",
      "NULL, 1",
      /CHECK constraint failed: \(job_number IS NULL\)/
    ],
    [
      "a parent and no job number",
      "'main', NULL",
      /CHECK constraint failed: \(job_number IS NULL\)/
    ],
    [
      "a job number of 0",
      "'main', 0",
      /CHECK constraint failed: \(job_number IS NULL\)/
    ],
    [
      "a job number its parent already uses",
      "'main', 1",
      /UNIQUE constraint failed: conversations\.parent_conversation_id, conversations\.job_number/
    ],
    [
      "a parent that is not stored",
      "'missing', 1",
      /FOREIGN KEY constraint failed/
    ]
  ])("refuses a conversation with %s", (_label, parentAndNumber, failure) => {
    const database = openEmptyDatabase()
    migrateDatabase(database)
    database.exec(JOB_FIXTURE_SQL)

    expect(() =>
      database.exec(
        `INSERT INTO conversations (id, title, agent_code, created_at, updated_at, parent_conversation_id, job_number)
        VALUES ('c2', 'Title', 'researcher', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z', ${parentAndNumber})`
      )
    ).toThrow(failure)
    expect(getRowCount(database, "conversations")).toBe(2)
  })

  it.each([
    [
      "is stored without a title",
      `INSERT INTO conversations (id, title, agent_code, created_at, updated_at, parent_conversation_id, job_number)
      VALUES ('job2', NULL, 'researcher', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 'main', 2)`
    ],
    [
      "is stored with an empty title",
      `INSERT INTO conversations (id, title, agent_code, created_at, updated_at, parent_conversation_id, job_number)
      VALUES ('job2', '', 'researcher', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 'main', 2)`
    ],
    [
      "loses its title",
      "UPDATE conversations SET title = NULL WHERE id = 'job1'"
    ]
  ])("refuses a job that %s", (_label, change) => {
    const database = openEmptyDatabase()
    migrateDatabase(database)
    database.exec(JOB_FIXTURE_SQL)

    expect(() => database.exec(change)).toThrow(
      /CHECK constraint failed: \(job_number IS NULL\)/
    )
    expect(
      database.prepare("SELECT id, title FROM conversations ORDER BY id").all()
    ).toEqual([
      { id: "job1", title: "Find what moths eat" },
      { id: "main", title: null }
    ])
  })

  it.each([
    [
      "an origin on a reply",
      "'assistant', 'model', '', 'completed', 'stop', '2026-01-02T00:00:00.000Z', 'delegator', NULL",
      /CHECK constraint failed: origin IS NULL/
    ],
    [
      "an origin other than delegator and wake-up",
      "'user', NULL, 'Text', NULL, NULL, NULL, 'person', NULL",
      /CHECK constraint failed: origin IS NULL/
    ],
    [
      "a job call on the person's message",
      "'user', NULL, 'Text', NULL, NULL, NULL, NULL, 'call1'",
      /CHECK constraint failed: \(job_call_id IS NOT NULL\)/
    ],
    [
      "a job call on a wake-up message",
      "'user', NULL, 'Text', NULL, NULL, NULL, 'wake-up', 'call1'",
      /CHECK constraint failed: \(job_call_id IS NOT NULL\)/
    ],
    [
      "a delegator's origin and no job call",
      "'user', NULL, 'Text', NULL, NULL, NULL, 'delegator', NULL",
      /CHECK constraint failed: \(job_call_id IS NOT NULL\)/
    ],
    [
      "a job call that is not stored",
      "'user', NULL, 'Text', NULL, NULL, NULL, 'delegator', 'missing'",
      /FOREIGN KEY constraint failed/
    ]
  ])("refuses a message with %s", (_label, values, failure) => {
    const database = openEmptyDatabase()
    migrateDatabase(database)
    database.exec(JOB_FIXTURE_SQL)

    expect(() =>
      database.exec(
        `INSERT INTO conversation_messages
        (id, conversation_id, created_at, role, model, content, status, finish_reason, updated_at, origin, job_call_id)
        VALUES ('m2', 'job1', '2026-01-02T00:00:00.000Z', ${values})`
      )
    ).toThrow(failure)
    expect(getRowCount(database, "conversation_messages")).toBe(5)
  })

  it.each([
    [
      "an unknown kind",
      "('r1', 'job1', 'ja1', 'done', 'Find what moths eat', 'Text', '[]', '2026-01-02T00:00:00.000Z', NULL)",
      /CHECK constraint failed: kind IN/
    ],
    [
      "an empty note",
      "('r1', 'job1', 'ja1', 'note', 'Find what moths eat', '', '[]', '2026-01-02T00:00:00.000Z', NULL)",
      /CHECK constraint failed: kind NOT IN/
    ],
    [
      "an empty failed report",
      "('r1', 'job1', 'ja1', 'failed', 'Find what moths eat', '', '[]', '2026-01-02T00:00:00.000Z', NULL)",
      /CHECK constraint failed: kind NOT IN/
    ],
    [
      "an empty title",
      "('r1', 'job1', 'ja1', 'result', '', 'Text', '[]', '2026-01-02T00:00:00.000Z', NULL)",
      /CHECK constraint failed: title <> ''/
    ],
    [
      "source numbers that are not JSON",
      "('r1', 'job1', 'ja1', 'result', 'Find what moths eat', 'Text', '1,2', '2026-01-02T00:00:00.000Z', NULL)",
      /CHECK constraint failed: json_valid\(source_numbers\)/
    ],
    [
      "a second end report of its reply",
      `('r1', 'job1', 'ja1', 'result', 'Find what moths eat', 'Text', '[]', '2026-01-02T00:00:00.000Z', NULL),
      ('r2', 'job1', 'ja1', 'stopped', 'Find what moths eat', '', '[]', '2026-01-02T00:00:01.000Z', NULL)`,
      /UNIQUE constraint failed: job_reports\.reply_id/
    ],
    [
      "a job that is not stored",
      "('r1', 'missing', 'ja1', 'result', 'Find what moths eat', 'Text', '[]', '2026-01-02T00:00:00.000Z', NULL)",
      /FOREIGN KEY constraint failed/
    ],
    [
      "a reply that is not stored",
      "('r1', 'job1', 'missing', 'result', 'Find what moths eat', 'Text', '[]', '2026-01-02T00:00:00.000Z', NULL)",
      /FOREIGN KEY constraint failed/
    ],
    [
      "a delivering message that is not stored",
      "('r1', 'job1', 'ja1', 'result', 'Find what moths eat', 'Text', '[]', '2026-01-02T00:00:00.000Z', 'missing')",
      /FOREIGN KEY constraint failed/
    ]
  ])("refuses a report with %s", (_label, values, failure) => {
    const database = openEmptyDatabase()
    migrateDatabase(database)
    database.exec(JOB_FIXTURE_SQL)

    expect(() =>
      database.exec(
        `INSERT INTO job_reports (${JOB_REPORT_COLUMNS}) VALUES ${values}`
      )
    ).toThrow(failure)
    expect(getRowCount(database, "job_reports")).toBe(0)
  })

  it("stores two notes of one reply, and a result, a stopped, and an interrupted report without text", () => {
    const database = openEmptyDatabase()
    migrateDatabase(database)
    database.exec(JOB_FIXTURE_SQL)
    database.exec(`
      INSERT INTO conversation_messages (id, conversation_id, role, model, content, status, finish_reason, created_at, updated_at)
      VALUES
        ('ja2', 'job1', 'assistant', 'model', '', 'interrupted', NULL, '2026-01-01T00:00:05.000Z', '2026-01-01T00:00:05.000Z'),
        ('ja3', 'job1', 'assistant', 'model', '', 'interrupted', NULL, '2026-01-01T00:00:06.000Z', '2026-01-01T00:00:06.000Z')
    `)

    database.exec(`
      INSERT INTO job_reports (${JOB_REPORT_COLUMNS})
      VALUES
        ('n1', 'job1', 'ja1', 'note', 'Find what moths eat', 'Looking', '[]', '2026-01-01T00:00:04.100Z', 'u1'),
        ('n2', 'job1', 'ja1', 'note', 'Find what moths eat', 'Still looking', '[1,2]', '2026-01-01T00:00:04.200Z', NULL),
        ('e1', 'job1', 'ja1', 'result', 'Find what moths eat', '', '[]', '2026-01-01T00:00:04.300Z', NULL),
        ('e2', 'job1', 'ja2', 'stopped', 'Find what moths eat', '', '[]', '2026-01-01T00:00:05.100Z', NULL),
        ('e3', 'job1', 'ja3', 'interrupted', 'Find what moths eat', '', '[]', '2026-01-01T00:00:06.100Z', NULL)
    `)

    expect(listIds(database, "job_reports")).toEqual([
      "e1",
      "e2",
      "e3",
      "n1",
      "n2"
    ])
  })

  it("deletes a main conversation's jobs, their messages, and their reports with it, and nothing of another conversation", () => {
    const database = openEmptyDatabase()
    migrateDatabase(database)
    database.exec(JOB_FIXTURE_SQL)
    database.exec(DELIVERED_REPORT_FIXTURE_SQL)
    database.exec(OTHER_JOB_FIXTURE_SQL)

    database.exec("DELETE FROM conversations WHERE id = 'main'")

    expect(listIds(database, "conversations")).toEqual(["job9", "other"])
    expect(listIds(database, "conversation_messages")).toEqual(["ja9"])
    expect(listIds(database, "job_reports")).toEqual(["r9"])
  })

  it.each([
    [
      "a job message with the call that sent it",
      "DELETE FROM conversation_messages WHERE id = 'call1'",
      "SELECT id FROM conversation_messages WHERE id = 'ju1'"
    ],
    [
      "a report with its reply",
      "DELETE FROM conversation_messages WHERE id = 'ja1'",
      "SELECT id FROM job_reports WHERE id = 'r1'"
    ],
    [
      "a report with the message that delivered it",
      "DELETE FROM conversation_messages WHERE id = 'w1'",
      "SELECT id FROM job_reports WHERE id = 'r1'"
    ],
    [
      "a report with its job",
      "DELETE FROM conversations WHERE id = 'job1'",
      "SELECT id FROM job_reports WHERE id = 'r1'"
    ]
  ])("deletes %s", (_label, deletion, dependentRowQuery) => {
    const database = openEmptyDatabase()
    migrateDatabase(database)
    database.exec(JOB_FIXTURE_SQL)
    database.exec(DELIVERED_REPORT_FIXTURE_SQL)
    expect(database.prepare(dependentRowQuery).all()).toHaveLength(1)

    database.exec(deletion)

    expect(database.prepare(dependentRowQuery).all()).toEqual([])
  })

  it("deletes a report with its job, also when the report names a reply outside the job", () => {
    const database = openEmptyDatabase()
    migrateDatabase(database)
    database.exec(JOB_FIXTURE_SQL)
    database.exec(`
      INSERT INTO job_reports (${JOB_REPORT_COLUMNS})
      VALUES ('r1', 'job1', 'a1', 'result', 'Find what moths eat', 'They eat wool', '[]', '2026-01-01T00:00:05.000Z', NULL)
    `)

    database.exec("DELETE FROM conversations WHERE id = 'job1'")

    expect(listIds(database, "job_reports")).toEqual([])
    expect(listIds(database, "conversations")).toEqual(["main"])
  })

  it.each([
    [
      "a conversation's jobs",
      "SELECT id FROM conversations WHERE parent_conversation_id = ?",
      "SEARCH conversations USING INDEX conversations_job_number_idx "
    ],
    [
      "the job messages a call sent",
      "SELECT id FROM conversation_messages WHERE job_call_id = ?",
      "SEARCH conversation_messages USING INDEX conversation_messages_job_call_idx "
    ],
    [
      "a job's reports",
      "SELECT id FROM job_reports WHERE job_conversation_id = ?",
      "SEARCH job_reports USING INDEX job_reports_job_idx "
    ],
    [
      "a reply's reports",
      "SELECT id FROM job_reports WHERE reply_id = ?",
      "SEARCH job_reports USING INDEX job_reports_reply_idx "
    ],
    [
      "the reports a message delivered",
      "SELECT id FROM job_reports WHERE delivered_message_id = ?",
      "SEARCH job_reports USING INDEX job_reports_delivered_idx "
    ]
  ])(
    "finds %s through an index, so deleting what they reference scans no table",
    (_label, lookup, indexSearch) => {
      const database = openEmptyDatabase()
      migrateDatabase(database)

      const plan = database
        .prepare(`EXPLAIN QUERY PLAN ${lookup}`)
        .all("referenced")

      expect(plan.map((step) => step.detail)).toEqual([
        expect.stringContaining(indexSearch)
      ])
    }
  )

  it("rejects a database one version newer than the current one without changing it", () => {
    const database = openEmptyDatabase()
    database.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION + 1}`)

    expect(() => migrateDatabase(database)).toThrow(/is newer than supported/)

    expect(readUserVersion(database)).toBe(CURRENT_SCHEMA_VERSION + 1)
    expect(listSchemaObjects(database, "table")).toEqual([])
    expect(database.isTransaction).toBe(false)
  })

  it("rejects a database created by a newer version without changing it", () => {
    const database = openEmptyDatabase()
    database.exec("PRAGMA user_version = 99")

    // The message names both versions, in either order.
    expect(() => migrateDatabase(database)).toThrow(
      new RegExp(`^(?=.*\\b99\\b)(?=.*\\b${CURRENT_SCHEMA_VERSION}\\b)`)
    )

    expect(readUserVersion(database)).toBe(99)
    expect(listSchemaObjects(database, "table")).toEqual([])
    expect(database.isTransaction).toBe(false)
  })

  it("rejects a negative schema version marker", () => {
    const database = openEmptyDatabase()
    database.exec("PRAGMA user_version = -1")

    expect(() => migrateDatabase(database)).toThrow()

    expect(readUserVersion(database)).toBe(-1)
    expect(listSchemaObjects(database, "table")).toEqual([])
    expect(database.isTransaction).toBe(false)
  })

  it("rolls back every migration when one migration fails", () => {
    const database = openEmptyDatabase()
    database.exec("CREATE TABLE conversation_messages (id TEXT)")

    expect(() => migrateDatabase(database)).toThrow(
      /table conversation_messages already exists/
    )

    expect(readUserVersion(database)).toBe(0)
    expect(listSchemaObjects(database, "table")).toEqual([
      "conversation_messages"
    ])
    expect(database.isTransaction).toBe(false)
  })
})
