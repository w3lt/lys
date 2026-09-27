import { DatabaseSync } from "node:sqlite"
import { describe, expect, it, onTestFinished } from "vitest"
import { migrateDatabase } from "../../../../../src/di/services/conversationService/migrations"

/** Schema version produced by the current migration list. */
const CURRENT_SCHEMA_VERSION = 5

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

describe("migrateDatabase", () => {
  it("creates the current conversation schema in an empty database", () => {
    const database = openEmptyDatabase()

    migrateDatabase(database)

    expect(readUserVersion(database)).toBe(CURRENT_SCHEMA_VERSION)
    expect(listSchemaObjects(database, "table")).toEqual([
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
        `INSERT INTO conversations (id, title, system_prompt, created_at, updated_at)
        VALUES ('kept', NULL, 'prompt', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
      .run()

    migrateDatabase(database)

    expect(readUserVersion(database)).toBe(CURRENT_SCHEMA_VERSION)
    expect(database.prepare("SELECT id FROM conversations").all()).toEqual([
      { id: "kept" }
    ])
  })

  it("rejects a database created by a newer version without changing it", () => {
    const database = openEmptyDatabase()
    database.exec("PRAGMA user_version = 99")

    expect(() => migrateDatabase(database)).toThrow(
      `Database version 99 is newer than supported version ${CURRENT_SCHEMA_VERSION}`
    )

    expect(readUserVersion(database)).toBe(99)
    expect(listSchemaObjects(database, "table")).toEqual([])
    expect(database.isTransaction).toBe(false)
  })

  it("rejects a negative schema version marker", () => {
    const database = openEmptyDatabase()
    database.exec("PRAGMA user_version = -1")

    expect(() => migrateDatabase(database)).toThrow(
      "Invalid database user_version"
    )

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
