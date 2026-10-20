import { DatabaseSync } from "node:sqlite"
import { describe, expect, it, onTestFinished } from "vitest"
import { migrateDatabase } from "../../../../src/infrastructure/database/migrations"

/** Schema version produced by the current migration list. */
const CURRENT_SCHEMA_VERSION = 9

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
 * @remarks Migrates to the current version, then replaces what migration 9
 * changed with the historical version-8 objects: the sources table goes, and
 * the message table, its index, and its triggers come back as
 * {@link VERSION_8_MESSAGES_SQL}. The other tables are unchanged since
 * version 8.
 */
function createVersion8Database(): DatabaseSync {
  const database = openEmptyDatabase()
  migrateDatabase(database)
  database.exec(`
    DROP TABLE conversation_sources;
    DROP TABLE conversation_messages;
    ${VERSION_8_MESSAGES_SQL}
    PRAGMA user_version = 8
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

describe("migrateDatabase", () => {
  it("creates the current schema in an empty database", () => {
    const database = openEmptyDatabase()

    migrateDatabase(database)

    expect(readUserVersion(database)).toBe(CURRENT_SCHEMA_VERSION)
    expect(listSchemaObjects(database, "table")).toEqual([
      "agents",
      "conversation_messages",
      "conversation_sources",
      "conversations"
    ])
    expect(listSchemaObjects(database, "trigger")).toEqual([
      "update_conversation_after_message_insert",
      "update_conversation_after_message_update",
      "update_conversation_updated_at"
    ])
    expect(listSchemaObjects(database, "index")).toEqual([
      "conversation_messages_conversation_idx",
      "conversation_messages_reply_part_idx"
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
      "agent_code"
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
    expect(database.prepare("SELECT * FROM agents").all()).toEqual(agentsBefore)
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
