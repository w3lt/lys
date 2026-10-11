import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import SqliteDatabase from "../../../../src/infrastructure/database/sqliteDatabase"
import {
  createItemsTable,
  getThrownFailure,
  listItemNames,
  registerDatabaseFunctionRegistryContractSuite,
  registerDatabaseReaderContractSuite,
  registerDatabaseStatementCompilerContractSuite,
  registerDatabaseWriterContractSuite,
  type DatabaseTransactionsContractHarness
} from "../../support/databaseTransactionsContract"

/** Schema version produced by the current migration list. */
const CURRENT_SCHEMA_VERSION = 8

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
 * Opens an in-memory database for the shared contract suites.
 *
 * @returns The ready database, closed when the test finishes, and its close.
 */
function createContractHarness(): DatabaseTransactionsContractHarness {
  const database = openOwnedDatabase()
  return Object.freeze({
    database,
    closeDatabase: () => {
      database[Symbol.dispose]()
    }
  })
}

describe("SqliteDatabase", () => {
  registerDatabaseReaderContractSuite(createContractHarness)
  registerDatabaseWriterContractSuite(createContractHarness)
  registerDatabaseStatementCompilerContractSuite(createContractHarness)
  registerDatabaseFunctionRegistryContractSuite(createContractHarness)

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

    it("reopens a database at the current version with its stored data", () => {
      const databaseFilePath = createOwnedDatabaseFilePath()
      const first = openOwnedDatabase(databaseFilePath)
      createItemsTable(first)
      first.handleDatabaseWriteRequest((statements) => {
        statements
          .getStatement("INSERT INTO items (name) VALUES ('kept')")
          .run()
      })
      first[Symbol.dispose]()

      const reopened = openOwnedDatabase(databaseFilePath)

      expect(listItemNames(reopened)).toEqual(["kept"])
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
            .getStatement(
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

  describe("handleDatabaseWriteRequest", () => {
    it("commits the operation's changes before returning, visible to another connection", () => {
      const databaseFilePath = createOwnedDatabaseFilePath()
      const database = openOwnedDatabase(databaseFilePath)
      createItemsTable(database)
      const observer = openObserverConnection(databaseFilePath)

      database.handleDatabaseWriteRequest((statements) => {
        statements
          .getStatement("INSERT INTO items (name) VALUES ('kept')")
          .run()
      })

      expect(observer.prepare("SELECT name FROM items").all()).toEqual([
        { name: "kept" }
      ])
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
          .getStatement("INSERT INTO items (name) VALUES ('after')")
          .run()
      })
      expect(listItemNames(database)).toEqual(["after"])
    })

    it("keeps refusing transaction control and changes outside operations after the write lock was unavailable", () => {
      const databaseFilePath = createOwnedDatabaseFilePath()
      const database = openOwnedDatabase(databaseFilePath)
      createItemsTable(database)
      const insertItem = database.handleDatabaseReadRequest((statements) =>
        statements.getStatement("INSERT INTO items (name) VALUES (?)")
      )
      const otherConnection = openObserverConnection(databaseFilePath)
      otherConnection.exec("BEGIN IMMEDIATE")
      expect(() =>
        database.handleDatabaseWriteRequest(() => undefined)
      ).toThrow(/database is locked/)
      otherConnection.exec("ROLLBACK")

      expect(() => insertItem.run("outside")).toThrow(
        /attempt to write a readonly database/
      )
      database.handleDatabaseWriteRequest((statements) => {
        expect(() => statements.getStatement("BEGIN")).toThrow(/not authorized/)
      })
      expect(listItemNames(database)).toEqual([])
    })
  })

  describe("[Symbol.dispose]", () => {
    it("refuses every later call before using the connection and finalizes kept statements", () => {
      const database = openOwnedDatabase()
      createItemsTable(database)
      const insertItem = database.handleDatabaseReadRequest((statements) =>
        statements.getStatement("INSERT INTO items (name) VALUES (?)")
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
