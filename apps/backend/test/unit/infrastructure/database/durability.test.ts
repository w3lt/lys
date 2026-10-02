import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it, onTestFinished } from "vitest"
import { updateDatabaseDurability } from "../../../../src/infrastructure/database/durability"

/**
 * Creates a database file location in a directory owned by the current test.
 *
 * @returns An absolute path whose directory is removed when the test finishes.
 */
function createOwnedDatabaseFilePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "lys-durability-test-"))
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true })
  })
  return join(directory, "lys_db.sqlite")
}

/**
 * Opens a connection owned by the current test.
 *
 * @param databaseFilePath - SQLite location to open.
 * @returns The connection, closed when the test finishes unless a case closed
 * it.
 */
function openOwnedConnection(databaseFilePath: string): DatabaseSync {
  const database = new DatabaseSync(databaseFilePath)
  onTestFinished(() => {
    if (database.isOpen) database.close()
  })
  return database
}

describe("updateDatabaseDurability", () => {
  it("switches a file database to write-ahead logging with normal syncing", () => {
    const database = openOwnedConnection(createOwnedDatabaseFilePath())

    updateDatabaseDurability(database)

    expect(database.prepare("PRAGMA journal_mode").get()).toEqual({
      journal_mode: "wal"
    })
    expect(database.prepare("PRAGMA synchronous").get()).toEqual({
      synchronous: 1
    })
  })

  it("stores write-ahead logging in the file for later connections", () => {
    const databaseFilePath = createOwnedDatabaseFilePath()
    const database = openOwnedConnection(databaseFilePath)
    updateDatabaseDurability(database)
    database.close()

    expect(
      openOwnedConnection(databaseFilePath).prepare("PRAGMA journal_mode").get()
    ).toEqual({ journal_mode: "wal" })
  })

  it("keeps an in-memory database in memory journal mode", () => {
    const database = openOwnedConnection(":memory:")

    updateDatabaseDurability(database)

    expect(database.prepare("PRAGMA journal_mode").get()).toEqual({
      journal_mode: "memory"
    })
  })
})
