import type { SQLInputValue, SQLOutputValue, StatementSync } from "node:sqlite"

/**
 * Compiles SQL on the shared database connection for the store running an
 * operation.
 *
 * @remarks Lent to each {@link DatabaseOperation} by the database owner for
 * that call only. It offers neither connection closing nor unprepared SQL, and
 * the owner refuses to compile transaction-control statements or to lift the
 * connection's write protection through it, so a store can neither close the
 * database nor end its transaction early. Concurrency model: single-owner,
 * confined to the owner's event loop.
 */
export interface DatabaseStatementCompiler {
  /**
   * Returns the shared connection's compiled statement for one SQL text.
   *
   * @param sql - One fixed SQL statement, not text built from runtime values;
   * its values are supplied as bound parameters when it runs. Each distinct
   * text stays compiled until the database closes.
   * @returns The statement compiled on the first request for this text and
   * returned again for every later request, in this or any later operation.
   * It is owned by the database owner, which finalizes it when the database
   * closes; running it after that throws. Every operation compiling the same
   * text shares it, so a caller does not change its settings or leave an
   * iteration open beyond its operation. A statement kept beyond its operation
   * cannot change the database: outside a write operation SQLite refuses every
   * change with `attempt to write a readonly database`.
   * @throws `Database is closed` after the owner closes the database.
   * @throws `Database operation has ended` once the operation it was lent to
   * has returned.
   * @throws If SQLite rejects the SQL, including `not authorized` for `BEGIN`,
   * `COMMIT`, `END`, `ROLLBACK`, `SAVEPOINT`, `RELEASE`, any other
   * transaction-control statement, or the `query_only` pragma. The running
   * transaction is unchanged.
   */
  createStatement(sql: string): StatementSync
}

/**
 * Result of a database operation, limited to values that exist when the
 * operation returns.
 *
 * @typeParam Result - Value the operation returns.
 * @remarks Resolves to `never` for a promise-like result, so an asynchronous
 * operation does not type-check: its work after the first `await` would run
 * after the operation's transaction ended.
 */
export type SynchronousDatabaseResult<Result> =
  Result extends PromiseLike<unknown> ? never : Result

/**
 * Synchronous store work run inside one database transaction.
 *
 * @typeParam Result - Value returned to the store after the transaction ends.
 * @remarks The statement compiler is lent for this call only. The operation
 * finishes its database work before returning; the result type refuses a
 * promise, and a promise-like result that bypasses the type is rejected at
 * run time because its transaction has already ended.
 */
export type DatabaseOperation<Result> = (
  statements: DatabaseStatementCompiler
) => SynchronousDatabaseResult<Result>

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
 * @remarks Consumed by conversation history queries. Lent by the database
 * owner without the authority to close the connection. Concurrency model:
 * single-owner; each call completes synchronously on the owner's event loop
 * and is never nested inside another operation. Every implementation fails
 * with `Database is closed` after its owner closes the database.
 */
export interface DatabaseReader {
  /**
   * Runs one operation in a read transaction that changes nothing.
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
   * @throws The operation's own failure after the snapshot is released,
   * including `attempt to write a readonly database` for a change it attempts,
   * or the failure to release the snapshot after the operation succeeded.
   * @throws An `AggregateError` holding that failure followed by each failure
   * to release the snapshot or restore write protection.
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
   * returns a promise-like value; the changes it made before returning are
   * rolled back, and work it does after returning cannot change the database.
   * @throws The operation's or the commit's failure after every change is
   * rolled back.
   * @throws An `AggregateError` holding that failure followed by each failure
   * to roll back or restore write protection.
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
