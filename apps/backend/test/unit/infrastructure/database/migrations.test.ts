import { DatabaseSync } from "node:sqlite"
import { describe, expect, it, onTestFinished } from "vitest"
import { migrateDatabase } from "../../../../src/infrastructure/database/migrations"

/** Schema version produced by the current migration list. */
const CURRENT_SCHEMA_VERSION = 8

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
 * Creates a database with the version-6 conversations table.
 *
 * @returns A connection at `user_version` 6, closed when the test finishes.
 * @remarks Migrates to the current version and reverses migration 7, which
 * changes only the conversations table: it drops `agent_code` and adds
 * `system_prompt` back. SQLite requires the re-added column to have a default,
 * which the version-6 table lacked; every case writes the column explicitly,
 * so the default is never used.
 */
function createVersion6Database(): DatabaseSync {
  const database = openEmptyDatabase()
  migrateDatabase(database)
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
 * @remarks Migrates to the current version and resets the version marker:
 * migration 8 changes only rows, and an empty database has none to change.
 */
function createVersion7Database(): DatabaseSync {
  const database = openEmptyDatabase()
  migrateDatabase(database)
  database.exec("PRAGMA user_version = 7")
  return database
}

describe("migrateDatabase", () => {
  it("creates the current schema in an empty database", () => {
    const database = openEmptyDatabase()

    migrateDatabase(database)

    expect(readUserVersion(database)).toBe(CURRENT_SCHEMA_VERSION)
    expect(listSchemaObjects(database, "table")).toEqual([
      "agents",
      "conversation_messages",
      "conversations"
    ])
    expect(listSchemaObjects(database, "trigger")).toEqual([
      "update_conversation_after_message_insert",
      "update_conversation_after_message_update",
      "update_conversation_updated_at"
    ])
    expect(listSchemaObjects(database, "index")).toEqual([
      "conversation_messages_conversation_idx"
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
    const messagesBefore = database
      .prepare("SELECT * FROM conversation_messages")
      .all()

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
    expect(
      database.prepare("SELECT * FROM conversation_messages").all()
    ).toEqual(messagesBefore)
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
    const messagesBefore = database
      .prepare("SELECT * FROM conversation_messages")
      .all()
    const agentsBefore = database.prepare("SELECT * FROM agents").all()

    migrateDatabase(database)

    expect(readUserVersion(database)).toBe(8)
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
    expect(
      database.prepare("SELECT * FROM conversation_messages").all()
    ).toEqual(messagesBefore)
    expect(database.prepare("SELECT * FROM agents").all()).toEqual(agentsBefore)
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
