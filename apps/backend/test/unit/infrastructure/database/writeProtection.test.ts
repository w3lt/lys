import { DatabaseSync } from "node:sqlite"
import { describe, expect, it, onTestFinished } from "vitest"
import { updateDatabaseWriteProtection } from "../../../../src/infrastructure/database/writeProtection"

/**
 * Opens an in-memory database with one stored item, owned by the current test.
 *
 * @returns The connection, closed when the test finishes.
 */
function openOwnedDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:")
  onTestFinished(() => {
    if (database.isOpen) database.close()
  })
  database.exec("CREATE TABLE items (name TEXT NOT NULL)")
  database.exec("INSERT INTO items (name) VALUES ('stored')")
  return database
}

describe("updateDatabaseWriteProtection", () => {
  it("makes the connection refuse every change and still read", () => {
    const database = openOwnedDatabase()

    updateDatabaseWriteProtection(database)

    expect(() =>
      database.exec("INSERT INTO items (name) VALUES ('refused')")
    ).toThrow(/attempt to write a readonly database/)
    expect(() => database.exec("CREATE TABLE other (id INTEGER)")).toThrow(
      /attempt to write a readonly database/
    )
    expect(database.prepare("SELECT name FROM items").all()).toEqual([
      { name: "stored" }
    ])
  })
})
