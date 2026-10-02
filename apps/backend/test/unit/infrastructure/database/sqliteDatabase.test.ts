import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import SqliteDatabase from "../../../../src/infrastructure/database/sqliteDatabase"

/** Schema version produced by the current migration list. */
const CURRENT_SCHEMA_VERSION = 5

/** Statements that would end or restart an operation's transaction. */
const TRANSACTION_CONTROL_STATEMENTS = [
  "BEGIN",
  "BEGIN IMMEDIATE",
  "COMMIT",
  "END",
  "ROLLBACK"
] as const

/**
 * Creates a database file location in a directory owned by the current test.
 *
 * @returns An absolute path whose directory is removed when the test finishes.
 */
function createOwnedDatabaseFilePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "lys-database-test-"))
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true })
  })
  return join(directory, "lys_db.sqlite")
}

/**
 * Opens a database owned by the current test.
 *
 * @param databaseFilePath - SQLite location; an isolated in-memory database
 * when omitted.
 * @returns The ready database, closed when the test finishes; closing is
 * idempotent, so a case may close it earlier.
 */
function openOwnedDatabase(databaseFilePath = ":memory:"): SqliteDatabase {
  const database = SqliteDatabase.open(databaseFilePath)
  onTestFinished(() => {
    database[Symbol.dispose]()
  })
  return database
}

/**
 * Opens an independent connection to a database file, owned by the current
 * test.
 *
 * @param databaseFilePath - File opened by the database under test.
 * @returns A raw connection, closed when the test finishes.
 */
function openObserverConnection(databaseFilePath: string): DatabaseSync {
  const connection = new DatabaseSync(databaseFilePath)
  onTestFinished(() => {
    if (connection.isOpen) connection.close()
  })
  return connection
}

/**
 * Creates the test-only `items` table in one write operation.
 *
 * @param database - Database under test.
 */
function createItemsTable(database: SqliteDatabase): void {
  database.handleDatabaseWriteRequest((statements) => {
    statements.createStatement("CREATE TABLE items (name TEXT NOT NULL)").run()
  })
}

/**
 * Lists stored item names in insertion order from a fresh snapshot.
 *
 * @param database - Database under test.
 * @returns The committed names.
 */
function listItemNames(database: SqliteDatabase): unknown[] {
  return database.handleDatabaseReadRequest((statements) =>
    statements
      .createStatement("SELECT name FROM items ORDER BY rowid")
      .all()
      .map((row) => row.name)
  )
}

/**
 * Runs an action that must throw and returns what it threw.
 *
 * @param action - Action under test.
 * @returns The thrown value, so a case can compare it by identity.
 * @throws If the action returns without throwing.
 */
function getThrownFailure(action: () => unknown): unknown {
  try {
    action()
  } catch (error) {
    return error
  }
  throw new Error("Expected the action to throw")
}

describe("SqliteDatabase", () => {
  describe("open", () => {
    it("migrates a new file to the current schema with write-ahead logging", () => {
      const databaseFilePath = createOwnedDatabaseFilePath()

      openOwnedDatabase(databaseFilePath)

      const observer = openObserverConnection(databaseFilePath)
      expect(observer.prepare("PRAGMA user_version").get()).toEqual({
        user_version: CURRENT_SCHEMA_VERSION
      })
      expect(observer.prepare("PRAGMA journal_mode").get()).toEqual({
        journal_mode: "wal"
      })
    })

    it("enforces foreign keys in store operations", () => {
      const database = openOwnedDatabase()

      expect(() =>
        database.handleDatabaseWriteRequest((statements) =>
          statements
            .createStatement(
              `INSERT INTO conversation_messages (id, conversation_id, role, content, created_at)
              VALUES ('message', 'missing', 'user', 'Hello', '2026-01-01T00:00:00.000Z')`
            )
            .run()
        )
      ).toThrow(/FOREIGN KEY constraint failed/)
    })

    it("refuses a newer schema version, leaves the file unchanged, and closes its connection", () => {
      const databaseFilePath = createOwnedDatabaseFilePath()
      const seed = new DatabaseSync(databaseFilePath)
      seed.exec("PRAGMA user_version = 99")
      seed.close()
      const disposeConnection = vi.spyOn(DatabaseSync.prototype, Symbol.dispose)

      // The message names both versions, in either order.
      expect(() => SqliteDatabase.open(databaseFilePath)).toThrow(
        new RegExp(`^(?=.*\\b99\\b)(?=.*\\b${CURRENT_SCHEMA_VERSION}\\b)`)
      )

      expect(disposeConnection).toHaveBeenCalledOnce()
      const observer = openObserverConnection(databaseFilePath)
      expect(observer.prepare("PRAGMA user_version").get()).toEqual({
        user_version: 99
      })
      expect(observer.prepare("PRAGMA journal_mode").get()).toEqual({
        journal_mode: "delete"
      })
      expect(
        observer.prepare("SELECT count(*) AS count FROM sqlite_schema").get()
      ).toEqual({ count: 0 })
    })

    it("opens separate in-memory databases independently", () => {
      const first = openOwnedDatabase()
      const second = openOwnedDatabase()

      createItemsTable(first)

      expect(() => listItemNames(second)).toThrow(/no such table: items/)
    })
  })

  describe("handleDatabaseReadRequest", () => {
    it("returns the operation's result and discards its changes", () => {
      const database = openOwnedDatabase()
      createItemsTable(database)

      const seen = database.handleDatabaseReadRequest((statements) => {
        statements
          .createStatement("INSERT INTO items (name) VALUES ('discarded')")
          .run()
        return statements.createStatement("SELECT name FROM items").all()
      })

      expect(seen).toEqual([{ name: "discarded" }])
      expect(listItemNames(database)).toEqual([])
    })

    it("rethrows the operation's failure after ending the snapshot", () => {
      const database = openOwnedDatabase()
      const failure = new Error("read failed")

      expect(
        getThrownFailure(() =>
          database.handleDatabaseReadRequest(() => {
            throw failure
          })
        )
      ).toBe(failure)

      expect(database.handleDatabaseWriteRequest(() => "written")).toBe(
        "written"
      )
    })

    it("rejects an operation that returns a promise after ending the snapshot", () => {
      const database = openOwnedDatabase()

      expect(() =>
        database.handleDatabaseReadRequest(async () => "late")
      ).toThrow("Database operations must be synchronous")

      expect(database.handleDatabaseWriteRequest(() => "written")).toBe(
        "written"
      )
    })
  })

  describe("handleDatabaseWriteRequest", () => {
    it("commits the operation's changes before returning its result", () => {
      const databaseFilePath = createOwnedDatabaseFilePath()
      const database = openOwnedDatabase(databaseFilePath)
      createItemsTable(database)
      const observer = openObserverConnection(databaseFilePath)

      const changes = database.handleDatabaseWriteRequest(
        (statements) =>
          statements
            .createStatement("INSERT INTO items (name) VALUES ('kept')")
            .run().changes
      )

      expect(changes).toBe(1)
      expect(observer.prepare("SELECT name FROM items").all()).toEqual([
        { name: "kept" }
      ])
    })

    it("rolls back every change and rethrows the same failure when the operation fails", () => {
      const database = openOwnedDatabase()
      createItemsTable(database)
      const failure = new Error("write failed")

      const thrown = getThrownFailure(() =>
        database.handleDatabaseWriteRequest((statements) => {
          statements
            .createStatement("INSERT INTO items (name) VALUES ('discarded')")
            .run()
          throw failure
        })
      )

      expect(thrown).toBe(failure)
      expect(listItemNames(database)).toEqual([])
    })

    it("rolls back every change when the commit fails", () => {
      const database = openOwnedDatabase()
      database.handleDatabaseWriteRequest((statements) => {
        statements
          .createStatement("CREATE TABLE parents (id TEXT PRIMARY KEY)")
          .run()
        statements
          .createStatement(
            "CREATE TABLE children (parent_id TEXT REFERENCES parents (id) DEFERRABLE INITIALLY DEFERRED)"
          )
          .run()
      })

      expect(() =>
        database.handleDatabaseWriteRequest((statements) => {
          statements
            .createStatement(
              "INSERT INTO children (parent_id) VALUES ('missing')"
            )
            .run()
        })
      ).toThrow(/FOREIGN KEY constraint failed/)

      expect(
        database.handleDatabaseReadRequest((statements) =>
          statements
            .createStatement("SELECT count(*) AS count FROM children")
            .get()
        )
      ).toEqual({ count: 0 })
    })

    it("rejects an operation that returns a promise and rolls back its changes", () => {
      const database = openOwnedDatabase()
      createItemsTable(database)

      expect(() =>
        database.handleDatabaseWriteRequest(async (statements) => {
          statements
            .createStatement("INSERT INTO items (name) VALUES ('discarded')")
            .run()
        })
      ).toThrow("Database operations must be synchronous")

      expect(listItemNames(database)).toEqual([])
    })

    it("fails before running the operation while another connection holds the write lock", () => {
      const databaseFilePath = createOwnedDatabaseFilePath()
      const database = openOwnedDatabase(databaseFilePath)
      createItemsTable(database)
      const otherConnection = openObserverConnection(databaseFilePath)
      otherConnection.exec("BEGIN IMMEDIATE")
      const operation = vi.fn()

      expect(() => database.handleDatabaseWriteRequest(operation)).toThrow(
        /database is locked/
      )

      expect(operation).not.toHaveBeenCalled()
      otherConnection.exec("ROLLBACK")
      database.handleDatabaseWriteRequest((statements) => {
        statements
          .createStatement("INSERT INTO items (name) VALUES ('after')")
          .run()
      })
      expect(listItemNames(database)).toEqual(["after"])
    })
  })

  describe("operation restrictions", () => {
    it.each(TRANSACTION_CONTROL_STATEMENTS)(
      "refuses to compile %s inside an operation and keeps its transaction",
      (transactionControlSql) => {
        const database = openOwnedDatabase()
        createItemsTable(database)

        database.handleDatabaseWriteRequest((statements) => {
          statements
            .createStatement("INSERT INTO items (name) VALUES ('kept')")
            .run()
          expect(() =>
            statements.createStatement(transactionControlSql)
          ).toThrow(/not authorized/)
        })

        expect(listItemNames(database)).toEqual(["kept"])
      }
    )

    it("rejects SQL that does not compile and stays usable", () => {
      const database = openOwnedDatabase()
      createItemsTable(database)

      expect(() =>
        database.handleDatabaseWriteRequest((statements) =>
          statements.createStatement("SELEC name FROM items")
        )
      ).toThrow(/syntax error/)

      expect(listItemNames(database)).toEqual([])
    })

    it("rejects a nested operation and keeps the enclosing transaction", () => {
      const database = openOwnedDatabase()
      createItemsTable(database)

      database.handleDatabaseWriteRequest((statements) => {
        statements
          .createStatement("INSERT INTO items (name) VALUES ('outer')")
          .run()
        expect(() =>
          database.handleDatabaseReadRequest(() => undefined)
        ).toThrow("Database transactions cannot be nested")
        expect(() =>
          database.handleDatabaseWriteRequest(() => undefined)
        ).toThrow("Database transactions cannot be nested")
      })

      expect(listItemNames(database)).toEqual(["outer"])
    })
  })

  describe("kept statements", () => {
    it("run in later operations, including after a schema change", () => {
      const database = openOwnedDatabase()
      createItemsTable(database)
      const insertItem = database.handleDatabaseReadRequest((statements) =>
        statements.createStatement("INSERT INTO items (name) VALUES (?)")
      )

      database.handleDatabaseWriteRequest(() => insertItem.run("first"))
      database.handleDatabaseWriteRequest((statements) => {
        statements.createStatement("CREATE TABLE other (id INTEGER)").run()
      })
      database.handleDatabaseWriteRequest(() => insertItem.run("second"))

      expect(listItemNames(database)).toEqual(["first", "second"])
    })
  })

  describe("registerDatabaseFunction", () => {
    it("makes the function available to later operations", () => {
      const database = openOwnedDatabase()

      database.registerDatabaseFunction("double_value", (value) =>
        typeof value === "number" ? value * 2 : null
      )

      expect(
        database.handleDatabaseReadRequest((statements) =>
          statements.createStatement("SELECT double_value(21) AS result").get()
        )
      ).toEqual({ result: 42 })
    })
  })

  describe("[Symbol.dispose]", () => {
    it("refuses every later call before using the connection and finalizes kept statements", () => {
      const database = openOwnedDatabase()
      createItemsTable(database)
      const insertItem = database.handleDatabaseReadRequest((statements) =>
        statements.createStatement("INSERT INTO items (name) VALUES (?)")
      )
      const operation = vi.fn()

      database[Symbol.dispose]()

      expect(() => database.handleDatabaseReadRequest(operation)).toThrow(
        "Database is closed"
      )
      expect(() => database.handleDatabaseWriteRequest(operation)).toThrow(
        "Database is closed"
      )
      expect(() =>
        database.registerDatabaseFunction("late_value", () => null)
      ).toThrow("Database is closed")
      expect(operation).not.toHaveBeenCalled()
      expect(() => insertItem.run("late")).toThrow(/finalized/)
    })

    it("accepts repeated closing", () => {
      const database = openOwnedDatabase()
      database[Symbol.dispose]()

      expect(() => database[Symbol.dispose]()).not.toThrow()
    })

    it("stays closed without retrying when closing the connection fails", () => {
      const disposeConnection = vi.spyOn(DatabaseSync.prototype, Symbol.dispose)
      const database = SqliteDatabase.open(":memory:")
      const unclosedConnections: DatabaseSync[] = []
      onTestFinished(() => {
        for (const connection of unclosedConnections) connection.close()
      })
      const closeFailure = new Error("close failed")
      disposeConnection.mockImplementationOnce(function (this: DatabaseSync) {
        unclosedConnections.push(this)
        throw closeFailure
      })
      const operation = vi.fn()

      expect(getThrownFailure(() => database[Symbol.dispose]())).toBe(
        closeFailure
      )

      expect(() => database.handleDatabaseReadRequest(operation)).toThrow(
        "Database is closed"
      )
      expect(() => database.handleDatabaseWriteRequest(operation)).toThrow(
        "Database is closed"
      )
      expect(() =>
        database.registerDatabaseFunction("late_value", () => null)
      ).toThrow("Database is closed")
      expect(operation).not.toHaveBeenCalled()
      expect(() => database[Symbol.dispose]()).not.toThrow()
      expect(disposeConnection).toHaveBeenCalledOnce()
    })
  })
})
