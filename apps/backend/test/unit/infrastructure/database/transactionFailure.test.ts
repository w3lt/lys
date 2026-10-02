import { DatabaseSync } from "node:sqlite"
import { describe, expect, it, onTestFinished } from "vitest"
import { handleTransactionFailure } from "../../../../src/infrastructure/database/transactionFailure"

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
  it("rolls back the active transaction and rethrows the original failure", () => {
    const database = openDatabase()
    const failure = new Error("constraint failed")
    database.exec("BEGIN")
    database.exec("INSERT INTO items (name) VALUES ('uncommitted')")

    expect(getThrownTransactionFailure(database, failure)).toBe(failure)

    expect(database.isTransaction).toBe(false)
    expect(
      database.prepare("SELECT count(*) AS count FROM items").get()
    ).toEqual({ count: 0 })
  })

  it("rethrows the original failure unchanged when no transaction is active", () => {
    const database = openDatabase()
    database.exec("INSERT INTO items (name) VALUES ('committed')")
    const failure = "non-error failure"

    expect(getThrownTransactionFailure(database, failure)).toBe(failure)

    expect(
      database.prepare("SELECT count(*) AS count FROM items").get()
    ).toEqual({ count: 1 })
  })

  it("keeps both failures when the rollback attempt fails", () => {
    const database = openDatabase()
    const failure = new Error("constraint failed")
    database.close()

    const thrown = getThrownTransactionFailure(database, failure)

    expect(thrown).toBeInstanceOf(AggregateError)
    expect(thrown).toMatchObject({
      message: "Database operation and rollback both failed",
      errors: [failure, expect.any(Error)]
    })
  })
})
