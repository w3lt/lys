import type { PathLike } from "node:fs"
import { DatabaseSync, constants } from "node:sqlite"
import { migrateDatabase } from "./migrations"
import { handleTransactionFailure } from "./transactionFailure"

/**
 * Statement access available inside one {@link SqliteTransactions} operation.
 *
 * @remarks Offers no closure or `exec`, and the owner's SQLite authorizer
 * rejects every transaction-control statement (`BEGIN`, `COMMIT`, `END`,
 * `ROLLBACK`) prepared through it, so an operation can end neither its
 * transaction nor the shared connection. Statements prepared through it must
 * not be used after the operation returns. A registered SQL function stays
 * installed on the shared connection until the database closes.
 */
export type SqliteQueries = Pick<DatabaseSync, "prepare" | "function">

/**
 * Synchronous work performed inside one transaction.
 *
 * @typeParam Result - Value returned to the caller after the transaction ends.
 */
export type SqliteTransactionOperation<Result> = (
  queries: SqliteQueries
) => Result

/**
 * Transactional access to the shared SQLite database, lent to stores.
 *
 * @remarks Grants no authority to close the database. Calls run synchronously
 * on the single connection, one at a time, and must not be nested. Every call
 * throws after the owner closes the database.
 */
export interface SqliteTransactions {
  /**
   * Runs an operation against one read snapshot and discards any change it
   * makes.
   *
   * @typeParam Result - Value produced by the operation.
   * @param operation - Synchronous work whose statement access is valid only
   * during this call.
   * @returns The operation's result after the snapshot is released.
   * @throws `Database is closed` after the owner closes the database.
   * @throws `SQLite transactions cannot be nested` when called inside another
   * operation; the enclosing transaction is left untouched.
   * @throws `SQLite transaction operations must be synchronous` when the
   * operation returns a promise-like value, after the snapshot is released.
   * @throws If SQLite cannot begin the transaction; nothing is changed.
   * @throws The operation's own failure, or an `AggregateError` holding it and
   * a rollback failure.
   */
  read<Result>(operation: SqliteTransactionOperation<Result>): Result
  /**
   * Runs an operation in one write transaction and commits its changes.
   *
   * @typeParam Result - Value produced by the operation.
   * @param operation - Synchronous work whose statement access is valid only
   * during this call.
   * @returns The operation's result after the commit succeeds.
   * @throws `Database is closed` after the owner closes the database.
   * @throws `SQLite transactions cannot be nested` when called inside another
   * operation; the enclosing transaction is left untouched.
   * @throws `SQLite transaction operations must be synchronous` when the
   * operation returns a promise-like value; its changes are rolled back.
   * @throws If SQLite cannot begin the transaction; nothing is changed.
   * @throws The operation's or the commit's failure after rollback, or an
   * `AggregateError` holding it and a rollback failure.
   * @remarks The write lock is taken when the transaction begins.
   */
  write<Result>(operation: SqliteTransactionOperation<Result>): Result
}

/**
 * Permission the owner grants itself, and the connection's authorizer checks,
 * for issuing its own transaction-control statements.
 */
type TransactionControlPermission = {
  /** Whether a transaction-control statement may be prepared right now. */
  allowed: boolean
}

/**
 * Owns the backend's single SQLite connection, its schema version, and its
 * closure.
 *
 * @remarks Single-owner, synchronous use: each call completes before another
 * event-loop callback runs, and calls are not reentrant. The composition root
 * holds the instance and its disposal; stores receive only
 * {@link SqliteTransactions}. Closure is terminal and idempotent, including
 * after a failed release.
 */
export default class SqliteDatabase implements SqliteTransactions, Disposable {
  /** Connection borrowed from the exclusively owned disposal stack. */
  readonly #database: DatabaseSync
  /** Statement-only view of the connection given to every operation. */
  readonly #queries: SqliteQueries
  /** Permission checked by the connection's authorizer; granted only to this owner. */
  readonly #transactionControl: TransactionControlPermission
  /** Sole release owner and terminal admission guard. */
  readonly #lifetime: DisposableStack

  /**
   * Retains a migrated connection and takes over its release.
   *
   * @param database - Migrated connection borrowed from `lifetime`, with its
   * authorizer already installed.
   * @param transactionControl - Permission read by that authorizer, withheld
   * until this owner issues its own transaction statements.
   * @param lifetime - Exclusive release obligation transferred by
   * {@link SqliteDatabase.open}.
   */
  private constructor(
    database: DatabaseSync,
    transactionControl: TransactionControlPermission,
    lifetime: DisposableStack
  ) {
    this.#database = database
    this.#queries = Object.freeze({
      prepare: database.prepare.bind(database),
      function: database.function.bind(database)
    })
    this.#transactionControl = transactionControl
    this.#lifetime = lifetime
  }

  /**
   * Opens, configures, and migrates the database before publishing it.
   *
   * @param databaseFilePath - SQLite location; `:memory:` opens an isolated
   * database.
   * @returns The ready database, whose closure belongs to the caller.
   * @throws If the connection cannot be opened, the stored schema version is
   * newer than supported, or a migration fails. The connection is closed
   * before the failure propagates, and a failed migration changes nothing.
   * @remarks Enables foreign-key enforcement on the connection. After
   * migrating, installs an authorizer that rejects every transaction-control
   * statement except the ones this owner issues itself.
   */
  public static open(databaseFilePath: PathLike): SqliteDatabase {
    using lifetime = new DisposableStack()
    const database = lifetime.use(new DatabaseSync(databaseFilePath))
    database.exec("PRAGMA foreign_keys = ON")
    migrateDatabase(database)
    const transactionControl: TransactionControlPermission = { allowed: false }
    database.setAuthorizer((actionCode) =>
      actionCode === constants.SQLITE_TRANSACTION && !transactionControl.allowed
        ? constants.SQLITE_DENY
        : constants.SQLITE_OK
    )
    return new SqliteDatabase(database, transactionControl, lifetime.move())
  }

  /**
   * Implements {@link SqliteTransactions.read} with a deferred snapshot that is
   * always rolled back.
   *
   * @typeParam Result - Value produced by the operation.
   * @param operation - Interface-defined synchronous work.
   * @returns The interface-defined result.
   */
  public read<Result>(operation: SqliteTransactionOperation<Result>): Result {
    return this.#runTransaction("BEGIN", "ROLLBACK", operation)
  }

  /**
   * Implements {@link SqliteTransactions.write} with an immediate write
   * transaction.
   *
   * @typeParam Result - Value produced by the operation.
   * @param operation - Interface-defined synchronous work.
   * @returns The interface-defined result.
   */
  public write<Result>(operation: SqliteTransactionOperation<Result>): Result {
    return this.#runTransaction("BEGIN IMMEDIATE", "COMMIT", operation)
  }

  /**
   * Closes the connection once; every later read or write throws.
   *
   * @throws If SQLite fails to close the connection; the database still counts
   * as closed.
   */
  public [Symbol.dispose](): void {
    this.#lifetime.dispose()
  }

  /**
   * Runs one operation between a transaction's opening and closing statements.
   *
   * @typeParam Result - Value produced by the operation.
   * @param begin - Statement that opens the transaction.
   * @param end - Statement that ends the transaction after the operation
   * succeeds.
   * @param operation - Synchronous work receiving statement-only access.
   * @returns The operation's result after `end` succeeds.
   * @throws As documented by {@link SqliteTransactions.read} and
   * {@link SqliteTransactions.write}.
   */
  #runTransaction<Result>(
    begin: "BEGIN" | "BEGIN IMMEDIATE",
    end: "ROLLBACK" | "COMMIT",
    operation: SqliteTransactionOperation<Result>
  ): Result {
    if (this.#lifetime.disposed) throw new Error("Database is closed")
    if (this.#database.isTransaction)
      throw new Error("SQLite transactions cannot be nested")
    this.#runTransactionControl(() => this.#database.exec(begin))
    try {
      const result = operation(this.#queries)
      if (isPromiseLike(result))
        throw new Error("SQLite transaction operations must be synchronous")
      this.#runTransactionControl(() => this.#database.exec(end))
      return result
    } catch (error) {
      return this.#runTransactionControl(() =>
        handleTransactionFailure(this.#database, error)
      )
    }
  }

  /**
   * Runs work that issues this owner's own transaction statements past the
   * connection's authorizer.
   *
   * @typeParam Result - Value produced by the work.
   * @param work - Synchronous work that begins, commits, or rolls back.
   * @returns The work's result.
   * @throws The work's failure; the permission is withdrawn either way.
   */
  #runTransactionControl<Result>(work: () => Result): Result {
    this.#transactionControl.allowed = true
    try {
      return work()
    } finally {
      this.#transactionControl.allowed = false
    }
  }
}

/**
 * Reports whether an operation result would settle after its transaction ends.
 *
 * @param value - Result returned by a transaction operation.
 * @returns True for an object or function with a callable `then` member.
 */
function isPromiseLike(value: unknown): boolean {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  )
}
