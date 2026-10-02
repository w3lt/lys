import { DatabaseSync, constants } from "node:sqlite"
import { describe, expect, it, onTestFinished } from "vitest"
import { handleTransactionFailure } from "../../../../src/infrastructure/database/transactionFailure"

/** Failure SQLite reports for a change on a write-protected connection. */
const READ_ONLY_FAILURE = /attempt to write a readonly database/

/**
 * Opens an in-memory database with one table, owned by the current test.
 *
 * @returns An open connection closed when the test finishes.
 */
function openDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:")
  onTestFinished(() => {
    if (database.isOpen) {
      database.close()
    }
  })
  database.exec("CREATE TABLE items (name TEXT NOT NULL)")
  return database
}

/**
 * Runs the failure handler and returns the value it throws, so a case can
 * compare that value by identity.
 *
 * @param database - Connection passed to the handler.
 * @param failure - Original operation failure.
 * @returns The thrown value.
 * @throws If the handler returns without throwing.
 */
function getThrownTransactionFailure(
  database: DatabaseSync,
  failure: unknown
): unknown {
  try {
    handleTransactionFailure(database, failure)
  } catch (error) {
    return error
  }
  throw new Error("Expected the handler to throw")
}

describe("handleTransactionFailure", () => {
  it("rolls back the active transaction, restores write protection, and rethrows the original failure", () => {
    const database = openDatabase()
    const failure = new Error("constraint failed")
    database.exec("PRAGMA query_only = OFF; BEGIN IMMEDIATE")
    database.exec("INSERT INTO items (name) VALUES ('uncommitted')")

    expect(getThrownTransactionFailure(database, failure)).toBe(failure)

    expect(database.isTransaction).toBe(false)
    expect(
      database.prepare("SELECT count(*) AS count FROM items").get()
    ).toEqual({ count: 0 })
    expect(() =>
      database.exec("INSERT INTO items (name) VALUES ('refused')")
    ).toThrow(READ_ONLY_FAILURE)
  })

  it("restores write protection and rethrows the original failure unchanged when no transaction is active", () => {
    const database = openDatabase()
    database.exec("INSERT INTO items (name) VALUES ('committed')")
    const failure = "non-error failure"

    expect(getThrownTransactionFailure(database, failure)).toBe(failure)

    expect(
      database.prepare("SELECT count(*) AS count FROM items").get()
    ).toEqual({ count: 1 })
    expect(() =>
      database.exec("INSERT INTO items (name) VALUES ('refused')")
    ).toThrow(READ_ONLY_FAILURE)
  })

  it("restores write protection and keeps both failures when the rollback fails", () => {
    const database = openDatabase()
    const failure = new Error("constraint failed")
    database.exec("BEGIN")
    database.setAuthorizer((actionCode) =>
      actionCode === constants.SQLITE_TRANSACTION
        ? constants.SQLITE_DENY
        : constants.SQLITE_OK
    )

    const thrown = getThrownTransactionFailure(database, failure)

    expect(thrown).toBeInstanceOf(AggregateError)
    expect(thrown).toMatchObject({
      message: "Database operation and cleanup both failed",
      errors: [failure, expect.objectContaining({ message: "not authorized" })]
    })
    expect(() =>
      database.exec("INSERT INTO items (name) VALUES ('refused')")
    ).toThrow(READ_ONLY_FAILURE)
  })

  it("keeps the original failure and every cleanup failure when the connection is closed", () => {
    const database = openDatabase()
    const failure = new Error("constraint failed")
    database.close()

    const thrown = getThrownTransactionFailure(database, failure)

    expect(thrown).toBeInstanceOf(AggregateError)
    expect(thrown).toMatchObject({
      message: "Database operation and cleanup both failed",
      errors: [failure, expect.any(Error), expect.any(Error)]
    })
  })
})
