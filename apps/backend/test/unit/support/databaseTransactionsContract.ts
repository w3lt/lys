import { describe, expect, it, vi } from "vitest"
import type {
  DatabaseFunctionRegistry,
  DatabaseReader,
  DatabaseStatementCompiler,
  DatabaseWriter
} from "../../../src/infrastructure/database/databaseTransactions"

/** Shared-database capabilities implemented together by one provider. */
export type DatabaseTransactionsContractDatabase = DatabaseReader &
  DatabaseWriter &
  DatabaseFunctionRegistry

/** One ready provider under test and the close its owner holds. */
export type DatabaseTransactionsContractHarness = Readonly<{
  /** Ready, empty provider whose cleanup is registered with the current test. */
  database: DatabaseTransactionsContractDatabase
  /** Closes the provider as its owner does; a repeated call changes nothing. */
  closeDatabase: () => void
}>

/** Creates one ready, empty provider owned by the current test. */
export type DatabaseTransactionsContractFactory =
  () => DatabaseTransactionsContractHarness

/**
 * Statements that would end, restart, or partially roll back an operation's
 * transaction.
 */
const TRANSACTION_CONTROL_STATEMENTS = [
  "BEGIN",
  "BEGIN IMMEDIATE",
  "COMMIT",
  "END",
  "ROLLBACK",
  "SAVEPOINT store_savepoint",
  "RELEASE store_savepoint",
  "ROLLBACK TO store_savepoint"
] as const

/** Statements that would let a statement change data outside a write. */
const WRITE_PROTECTION_STATEMENTS = [
  "PRAGMA query_only = OFF",
  "PRAGMA QUERY_ONLY=0",
  "PRAGMA main.query_only = false"
] as const

/** Failure SQLite reports for a change attempted outside a write operation. */
const REFUSED_CHANGE_FAILURE = /attempt to write a readonly database/

/**
 * Creates the test-only `items` table in one write operation.
 *
 * @param database - Provider under test.
 */
export function createItemsTable(database: DatabaseWriter): void {
  database.handleDatabaseWriteRequest((statements) => {
    statements.getStatement("CREATE TABLE items (name TEXT NOT NULL)").run()
  })
}

/**
 * Lists stored item names in insertion order from a fresh snapshot.
 *
 * @param database - Provider under test.
 * @returns The committed names.
 */
export function listItemNames(database: DatabaseReader): unknown[] {
  return database.handleDatabaseReadRequest((statements) =>
    statements
      .getStatement("SELECT name FROM items ORDER BY rowid")
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
export function getThrownFailure(action: () => unknown): unknown {
  try {
    action()
  } catch (error) {
    return error
  }
  throw new Error("Expected the action to throw")
}

/**
 * Creates two tables whose reference is checked only when a write commits.
 *
 * @param database - Provider under test.
 * @remarks Inserting a child without its parent therefore fails at commit, not
 * at the insert.
 */
function createDeferredReferenceTables(database: DatabaseWriter): void {
  database.handleDatabaseWriteRequest((statements) => {
    statements.getStatement("CREATE TABLE parents (id TEXT PRIMARY KEY)").run()
    statements
      .getStatement(
        "CREATE TABLE children (parent_id TEXT REFERENCES parents (id) DEFERRABLE INITIALLY DEFERRED)"
      )
      .run()
  })
}

/**
 * Saves one item, waits for a microtask, then saves another, as an
 * asynchronous operation would.
 *
 * @param statements - Compilation lent to the operation.
 * @returns Settlement after the second save.
 * @throws What compiling or running the second save throws once the
 * operation's transaction has ended.
 */
async function saveItemsAroundAwait(
  statements: DatabaseStatementCompiler
): Promise<void> {
  statements.getStatement("INSERT INTO items (name) VALUES ('before')").run()
  await Promise.resolve()
  statements.getStatement("INSERT INTO items (name) VALUES ('after')").run()
}

/**
 * Registers the provider-independent {@link DatabaseReader} contract cases.
 *
 * @param createHarness - Creates a ready, empty provider for each case.
 */
export function registerDatabaseReaderContractSuite(
  createHarness: DatabaseTransactionsContractFactory
): void {
  describe("DatabaseReader contract", () => {
    it("returns the operation's result from committed data", () => {
      const { database } = createHarness()
      createItemsTable(database)
      database.handleDatabaseWriteRequest((statements) => {
        statements
          .getStatement("INSERT INTO items (name) VALUES ('kept')")
          .run()
      })

      expect(listItemNames(database)).toEqual(["kept"])
    })

    it("refuses every change the operation attempts", () => {
      const { database } = createHarness()
      createItemsTable(database)

      expect(() =>
        database.handleDatabaseReadRequest((statements) =>
          statements
            .getStatement("INSERT INTO items (name) VALUES ('refused')")
            .run()
        )
      ).toThrow(REFUSED_CHANGE_FAILURE)

      expect(listItemNames(database)).toEqual([])
    })

    it("rethrows the operation's failure after ending the snapshot", () => {
      const { database } = createHarness()
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
      const { database } = createHarness()

      expect(() =>
        // @ts-expect-error -- An operation's result type refuses a promise.
        database.handleDatabaseReadRequest(() => Promise.resolve("late"))
      ).toThrow("Database operations must be synchronous")

      expect(database.handleDatabaseWriteRequest(() => "written")).toBe(
        "written"
      )
    })

    it("rejects a nested operation and keeps the enclosing snapshot", () => {
      const { database } = createHarness()

      const result = database.handleDatabaseReadRequest(() => {
        expect(() =>
          database.handleDatabaseReadRequest(() => undefined)
        ).toThrow("Database transactions cannot be nested")
        return "outer"
      })

      expect(result).toBe("outer")
    })

    it("fails with Database is closed after its owner closes the database", () => {
      const { database, closeDatabase } = createHarness()
      const operation = vi.fn()

      closeDatabase()

      expect(() => database.handleDatabaseReadRequest(operation)).toThrow(
        "Database is closed"
      )
      expect(operation).not.toHaveBeenCalled()
    })
  })
}

/**
 * Registers the provider-independent {@link DatabaseWriter} contract cases.
 *
 * @param createHarness - Creates a ready, empty provider for each case.
 */
export function registerDatabaseWriterContractSuite(
  createHarness: DatabaseTransactionsContractFactory
): void {
  describe("DatabaseWriter contract", () => {
    it("commits the operation's changes before returning its result", () => {
      const { database } = createHarness()
      createItemsTable(database)

      const changes = database.handleDatabaseWriteRequest(
        (statements) =>
          statements
            .getStatement("INSERT INTO items (name) VALUES ('kept')")
            .run().changes
      )

      expect(changes).toBe(1)
      expect(listItemNames(database)).toEqual(["kept"])
    })

    it("rolls back every change and rethrows the same failure when the operation fails", () => {
      const { database } = createHarness()
      createItemsTable(database)
      const failure = new Error("write failed")

      const thrown = getThrownFailure(() =>
        database.handleDatabaseWriteRequest((statements) => {
          statements
            .getStatement("INSERT INTO items (name) VALUES ('discarded')")
            .run()
          throw failure
        })
      )

      expect(thrown).toBe(failure)
      expect(listItemNames(database)).toEqual([])
    })

    it("rolls back every change when the commit fails", () => {
      const { database } = createHarness()
      createDeferredReferenceTables(database)

      expect(() =>
        database.handleDatabaseWriteRequest((statements) => {
          statements
            .getStatement("INSERT INTO children (parent_id) VALUES ('missing')")
            .run()
        })
      ).toThrow(/FOREIGN KEY constraint failed/)

      expect(
        database.handleDatabaseReadRequest((statements) =>
          statements
            .getStatement("SELECT count(*) AS count FROM children")
            .get()
        )
      ).toEqual({ count: 0 })
    })

    it("keeps refusing transaction control after a failed commit", () => {
      const { database } = createHarness()
      createDeferredReferenceTables(database)
      expect(() =>
        database.handleDatabaseWriteRequest((statements) => {
          statements
            .getStatement("INSERT INTO children (parent_id) VALUES ('missing')")
            .run()
        })
      ).toThrow(/FOREIGN KEY constraint failed/)

      database.handleDatabaseWriteRequest((statements) => {
        expect(() => statements.getStatement("BEGIN")).toThrow(/not authorized/)
      })
    })

    it("rejects an operation that returns a promise and rolls back its changes", () => {
      const { database } = createHarness()
      createItemsTable(database)

      expect(() =>
        database.handleDatabaseWriteRequest(
          // @ts-expect-error -- An operation's result type refuses a promise.
          (statements: DatabaseStatementCompiler) =>
            new Promise<void>((resolve) => {
              statements
                .getStatement("INSERT INTO items (name) VALUES ('discarded')")
                .run()
              resolve()
            })
        )
      ).toThrow("Database operations must be synchronous")

      expect(listItemNames(database)).toEqual([])
    })

    it("keeps an asynchronous operation's work after its first await out of the database", async () => {
      const { database } = createHarness()
      createItemsTable(database)
      const startedOperations: Promise<void>[] = []

      expect(() =>
        database.handleDatabaseWriteRequest(
          // @ts-expect-error -- An operation's result type refuses a promise.
          (statements: DatabaseStatementCompiler) => {
            const operation = saveItemsAroundAwait(statements)
            startedOperations.push(operation)
            return operation
          }
        )
      ).toThrow("Database operations must be synchronous")

      await expect(Promise.all(startedOperations)).rejects.toThrow(
        "Database operation has ended"
      )
      expect(listItemNames(database)).toEqual([])
    })

    it("rejects a nested operation and keeps the enclosing transaction", () => {
      const { database } = createHarness()
      createItemsTable(database)

      database.handleDatabaseWriteRequest((statements) => {
        statements
          .getStatement("INSERT INTO items (name) VALUES ('outer')")
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

    it("fails with Database is closed after its owner closes the database", () => {
      const { database, closeDatabase } = createHarness()
      const operation = vi.fn()

      closeDatabase()

      expect(() => database.handleDatabaseWriteRequest(operation)).toThrow(
        "Database is closed"
      )
      expect(operation).not.toHaveBeenCalled()
    })
  })
}

/**
 * Registers the provider-independent {@link DatabaseStatementCompiler}
 * contract cases.
 *
 * @param createHarness - Creates a ready, empty provider for each case.
 */
export function registerDatabaseStatementCompilerContractSuite(
  createHarness: DatabaseTransactionsContractFactory
): void {
  describe("DatabaseStatementCompiler contract", () => {
    it.each(TRANSACTION_CONTROL_STATEMENTS)(
      "refuses to compile %s and keeps the operation's transaction",
      (transactionControlSql) => {
        const { database } = createHarness()
        createItemsTable(database)

        database.handleDatabaseWriteRequest((statements) => {
          statements
            .getStatement("INSERT INTO items (name) VALUES ('kept')")
            .run()
          expect(() => statements.getStatement(transactionControlSql)).toThrow(
            /not authorized/
          )
        })

        expect(listItemNames(database)).toEqual(["kept"])
      }
    )

    it.each(WRITE_PROTECTION_STATEMENTS)(
      "refuses to compile %s",
      (writeProtectionSql) => {
        const { database } = createHarness()

        database.handleDatabaseReadRequest((statements) => {
          expect(() => statements.getStatement(writeProtectionSql)).toThrow(
            /not authorized/
          )
        })
      }
    )

    it("rejects SQL that does not compile and stays usable", () => {
      const { database } = createHarness()
      createItemsTable(database)

      expect(() =>
        database.handleDatabaseWriteRequest((statements) =>
          statements.getStatement("SELEC name FROM items")
        )
      ).toThrow(/syntax error/)

      expect(listItemNames(database)).toEqual([])
    })

    it("returns one statement for each SQL text, within and across operations", () => {
      const { database } = createHarness()
      createItemsTable(database)
      const selectSql = "SELECT name FROM items"

      const [first, second] = database.handleDatabaseReadRequest(
        (statements) => [
          statements.getStatement(selectSql),
          statements.getStatement(selectSql)
        ]
      )
      const later = database.handleDatabaseWriteRequest((statements) =>
        statements.getStatement(selectSql)
      )

      expect(second).toBe(first)
      expect(later).toBe(first)
    })

    it("runs a kept statement in later operations, including after a schema change", () => {
      const { database } = createHarness()
      createItemsTable(database)
      const insertItem = database.handleDatabaseReadRequest((statements) =>
        statements.getStatement("INSERT INTO items (name) VALUES (?)")
      )

      database.handleDatabaseWriteRequest(() => insertItem.run("first"))
      database.handleDatabaseWriteRequest((statements) => {
        statements.getStatement("CREATE TABLE other (id INTEGER)").run()
      })
      database.handleDatabaseWriteRequest(() => insertItem.run("second"))

      expect(listItemNames(database)).toEqual(["first", "second"])
    })

    it("lets a kept statement change the database only inside a write operation", () => {
      const { database } = createHarness()
      createItemsTable(database)
      const insertItem = database.handleDatabaseWriteRequest((statements) =>
        statements.getStatement("INSERT INTO items (name) VALUES (?)")
      )

      expect(() => insertItem.run("outside")).toThrow(REFUSED_CHANGE_FAILURE)
      expect(() =>
        database.handleDatabaseReadRequest(() => insertItem.run("read"))
      ).toThrow(REFUSED_CHANGE_FAILURE)
      database.handleDatabaseWriteRequest(() => insertItem.run("written"))

      expect(listItemNames(database)).toEqual(["written"])
    })

    it("refuses changes outside operations before any write has run", () => {
      const { database } = createHarness()
      const createTable = database.handleDatabaseReadRequest((statements) =>
        statements.getStatement("CREATE TABLE items (name TEXT NOT NULL)")
      )

      expect(() => createTable.run()).toThrow(REFUSED_CHANGE_FAILURE)
      expect(() =>
        database.handleDatabaseReadRequest((statements) =>
          statements.getStatement("SELECT name FROM items").all()
        )
      ).toThrow(/no such table: items/)
    })

    it("keeps refusing changes outside operations after a failed write", () => {
      const { database } = createHarness()
      createItemsTable(database)
      const insertItem = database.handleDatabaseReadRequest((statements) =>
        statements.getStatement("INSERT INTO items (name) VALUES (?)")
      )
      expect(() =>
        database.handleDatabaseWriteRequest(() => {
          throw new Error("write failed")
        })
      ).toThrow("write failed")

      expect(() => insertItem.run("outside")).toThrow(REFUSED_CHANGE_FAILURE)
      expect(listItemNames(database)).toEqual([])
    })

    it("refuses to compile once its operation has ended", () => {
      const { database } = createHarness()
      const retainedStatements = database.handleDatabaseReadRequest(
        (statements) => statements
      )

      expect(() => retainedStatements.getStatement("SELECT 1")).toThrow(
        "Database operation has ended"
      )
    })

    it("refuses to compile inside a later operation and changes nothing", () => {
      const { database } = createHarness()
      createItemsTable(database)
      const retainedStatements = database.handleDatabaseReadRequest(
        (statements) => statements
      )

      expect(() =>
        database.handleDatabaseWriteRequest(() =>
          retainedStatements
            .getStatement("INSERT INTO items (name) VALUES ('kept')")
            .run()
        )
      ).toThrow("Database operation has ended")
      expect(listItemNames(database)).toEqual([])
    })

    it("refuses an already compiled SQL text inside a later operation", () => {
      const { database } = createHarness()
      createItemsTable(database)
      const selectSql = "SELECT name FROM items"
      const retainedStatements = database.handleDatabaseReadRequest(
        (statements) => {
          statements.getStatement(selectSql)
          return statements
        }
      )

      expect(() =>
        database.handleDatabaseReadRequest(() =>
          retainedStatements.getStatement(selectSql)
        )
      ).toThrow("Database operation has ended")
    })

    it("fails with Database is closed when used after its owner closes the database", () => {
      const { database, closeDatabase } = createHarness()
      const retainedStatements = database.handleDatabaseReadRequest(
        (statements) => statements
      )

      closeDatabase()

      expect(() => retainedStatements.getStatement("SELECT 1")).toThrow(
        "Database is closed"
      )
    })
  })
}

/**
 * Registers the provider-independent {@link DatabaseFunctionRegistry} contract
 * cases.
 *
 * @param createHarness - Creates a ready, empty provider for each case.
 */
export function registerDatabaseFunctionRegistryContractSuite(
  createHarness: DatabaseTransactionsContractFactory
): void {
  describe("DatabaseFunctionRegistry contract", () => {
    it("makes the function available to later operations", () => {
      const { database } = createHarness()

      database.registerDatabaseFunction("double_value", (value) =>
        typeof value === "number" ? value * 2 : null
      )

      expect(
        database.handleDatabaseReadRequest((statements) =>
          statements.getStatement("SELECT double_value(21) AS result").get()
        )
      ).toEqual({ result: 42 })
    })

    it("replaces a function registered under the same name and argument count", () => {
      const { database } = createHarness()
      database.registerDatabaseFunction("item_label", () => "first")

      database.registerDatabaseFunction("item_label", () => "second")

      expect(
        database.handleDatabaseReadRequest((statements) =>
          statements.getStatement("SELECT item_label() AS label").get()
        )
      ).toEqual({ label: "second" })
    })

    it("fails with Database is closed after its owner closes the database", () => {
      const { database, closeDatabase } = createHarness()

      closeDatabase()

      expect(() =>
        database.registerDatabaseFunction("late_value", () => null)
      ).toThrow("Database is closed")
    })
  })
}
