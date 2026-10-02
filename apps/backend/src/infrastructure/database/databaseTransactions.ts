import type { SQLInputValue, SQLOutputValue, StatementSync } from "node:sqlite"

/**
 * Compiles SQL on the shared database connection for the store running an
 * operation.
 *
 * @remarks Lent to each {@link DatabaseOperation} by the database owner. It
 * offers neither connection closing nor unprepared SQL, and the owner refuses
 * to compile transaction-control statements through it, so a store can
 * neither close the database nor end its transaction early.
 * Concurrency model: single-owner, confined to the owner's event loop.
 */
export interface DatabaseStatementCompiler {
  /**
   * Compiles one SQL statement on the shared connection.
   *
   * @param sql - One SQL statement whose values are supplied as bound
   * parameters when it runs.
   * @returns A new statement owned by the calling store. The store may keep it
   * and run it again in later operations, but runs it only inside an
   * operation. Closing the database finalizes it, after which running it
   * throws.
   * @throws If SQLite rejects the SQL, including `not authorized` for `BEGIN`,
   * `COMMIT`, `END`, `ROLLBACK`, or any other transaction-control statement.
   * The running transaction is unchanged.
   */
  createStatement(sql: string): StatementSync
}

/**
 * Synchronous store work run inside one database transaction.
 *
 * @typeParam Result - Value returned to the store after the transaction ends.
 * @remarks The statement compiler is lent for this call only. The operation
 * finishes its database work before returning: a promise-like result is
 * rejected because its transaction has already ended.
 */
export type DatabaseOperation<Result> = (
  statements: DatabaseStatementCompiler
) => Result

/**
 * Deterministic scalar SQL function added to the shared connection.
 *
 * @remarks Receives the SQL argument values of one call and returns its SQL
 * value. SQLite may reuse a result for equal arguments, so the function depends
 * only on its arguments.
 */
export type DatabaseFunction = (...values: SQLOutputValue[]) => SQLInputValue

/**
 * Runs store work against one consistent read snapshot of the shared database.
 *
 * @remarks Consumed by conversation history queries and by turn access, which
 * compiles its kept statement once. Lent by the database owner without the
 * authority to close the connection. Concurrency model: single-owner; each
 * call completes synchronously on the owner's event loop and is never nested
 * inside another operation. Every implementation fails with
 * `Database is closed` after its owner closes the database.
 */
export interface DatabaseReader {
  /**
   * Runs one operation in a read transaction and discards any change it makes.
   *
   * @typeParam Result - Value produced by the operation.
   * @param operation - Synchronous work; its statement compiler is valid for
   * this call only.
   * @returns The operation's result after the snapshot is released.
   * @throws `Database is closed` after the owner closes the database; the
   * operation does not run.
   * @throws `Database transactions cannot be nested` when called inside another
   * operation; the enclosing transaction is left untouched.
   * @throws If SQLite cannot begin the transaction; the operation does not run.
   * @throws `Database operations must be synchronous` when the operation
   * returns a promise-like value, after the snapshot is released.
   * @throws The operation's own failure after the snapshot is released, or an
   * `AggregateError` holding it followed by a rollback failure.
   */
  handleDatabaseReadRequest<Result>(
    operation: DatabaseOperation<Result>
  ): Result
}

/**
 * Runs store work in one atomic write transaction on the shared database.
 *
 * @remarks Consumed by conversation history edits, turn persistence, and the
 * conversation store's startup recovery. Lent by the database owner without the
 * authority to close the connection. Concurrency model: single-owner; each
 * call completes synchronously on the owner's event loop and is never nested
 * inside another operation. Every implementation fails with
 * `Database is closed` after its owner closes the database.
 */
export interface DatabaseWriter {
  /**
   * Runs one operation in a write transaction and commits its changes.
   *
   * @typeParam Result - Value produced by the operation.
   * @param operation - Synchronous work; its statement compiler is valid for
   * this call only.
   * @returns The operation's result after every change it made is committed.
   * @throws `Database is closed` after the owner closes the database; the
   * operation does not run.
   * @throws `Database transactions cannot be nested` when called inside another
   * operation; the enclosing transaction is left untouched.
   * @throws If SQLite cannot begin the transaction, for example `database is
   * locked` while another connection holds the write lock; the operation does
   * not run.
   * @throws `Database operations must be synchronous` when the operation
   * returns a promise-like value; its changes are rolled back.
   * @throws The operation's or the commit's failure after every change is
   * rolled back, or an `AggregateError` holding it followed by a rollback
   * failure.
   * @remarks The write lock is taken when the transaction begins, so the
   * operation cannot fail midway for lack of it.
   */
  handleDatabaseWriteRequest<Result>(
    operation: DatabaseOperation<Result>
  ): Result
}

/**
 * Adds application SQL functions to the shared database connection.
 *
 * @remarks Consumed by the conversation store, which registers its search
 * function when it is created. Lent by the database owner without the
 * authority to close the connection. Concurrency model: single-owner.
 */
export interface DatabaseFunctionRegistry {
  /**
   * Adds a deterministic SQL function, replacing one registered under the same
   * name and argument count.
   *
   * @param name - SQL function name used by store queries.
   * @param implementation - Function SQLite evaluates for each call.
   * @throws `Database is closed` after the owner closes the database.
   * @throws If SQLite rejects the registration.
   * @remarks The function stays registered until the database closes and is
   * available to every store's statements.
   */
  registerDatabaseFunction(name: string, implementation: DatabaseFunction): void
}
