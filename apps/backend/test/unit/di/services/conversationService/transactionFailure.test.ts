import { DatabaseSync } from "node:sqlite"
import { describe, expect, it, onTestFinished } from "vitest"
import { handleConversationTransactionFailure } from "../../../../../src/di/services/conversationService/transactionFailure"

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
 * Captures the value thrown by the failure handler.
 *
 * @param database - Connection passed to the handler.
 * @param failure - Original operation failure.
 * @returns The thrown value.
 */
function captureHandledFailure(
  database: DatabaseSync,
  failure: unknown
): unknown {
  try {
    handleConversationTransactionFailure(database, failure)
  } catch (error) {
    return error
  }
  throw new Error("Expected the handler to throw")
}

describe("handleConversationTransactionFailure", () => {
  it("rolls back the active transaction and rethrows the original failure", () => {
    const database = openDatabase()
    const failure = new Error("constraint failed")
    database.exec("BEGIN")
    database.exec("INSERT INTO items (name) VALUES ('uncommitted')")

    expect(captureHandledFailure(database, failure)).toBe(failure)

    expect(database.isTransaction).toBe(false)
    expect(
      database.prepare("SELECT count(*) AS count FROM items").get()
    ).toEqual({ count: 0 })
  })

  it("rethrows the original failure unchanged when no transaction is active", () => {
    const database = openDatabase()
    database.exec("INSERT INTO items (name) VALUES ('committed')")
    const failure = "non-error failure"

    expect(captureHandledFailure(database, failure)).toBe(failure)

    expect(
      database.prepare("SELECT count(*) AS count FROM items").get()
    ).toEqual({ count: 1 })
  })

  it("keeps both failures when the rollback attempt fails", () => {
    const database = openDatabase()
    const failure = new Error("constraint failed")
    database.close()

    const thrown = captureHandledFailure(database, failure)

    expect(thrown).toBeInstanceOf(AggregateError)
    expect(thrown).toMatchObject({
      errors: [failure, expect.any(Error)]
    })
  })
})
