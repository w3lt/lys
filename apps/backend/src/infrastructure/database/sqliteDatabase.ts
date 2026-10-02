import type { PathLike } from "node:fs"
import { DatabaseSync, constants, type StatementSync } from "node:sqlite"
import type {
  DatabaseFunction,
  DatabaseFunctionRegistry,
  DatabaseOperation,
  DatabaseReader,
  DatabaseStatementCompiler,
  DatabaseWriter
} from "./databaseTransactions"
import { updateDatabaseDurability } from "./durability"
import { migrateDatabase } from "./migrations"
import { handleTransactionFailure } from "./transactionFailure"

/** Statements that open and end one kind of owner transaction. */
type TransactionBoundary = Readonly<{
  /** Statement that opens the transaction. */
  begin: "BEGIN" | "BEGIN IMMEDIATE"
  /** Statement that ends the transaction after the operation succeeds. */
  end: "ROLLBACK" | "COMMIT"
}>

/** Deferred snapshot whose changes are always discarded. */
const READ_TRANSACTION_BOUNDARY: TransactionBoundary = Object.freeze({
  begin: "BEGIN",
  end: "ROLLBACK"
})

/** Write transaction that takes the write lock first and commits at the end. */
const WRITE_TRANSACTION_BOUNDARY: TransactionBoundary = Object.freeze({
  begin: "BEGIN IMMEDIATE",
  end: "COMMIT"
})

/**
 * Owns the permission that lets only the database owner's own transaction
 * statements past the connection's authorizer.
 *
 * @remarks Invariant: permission is granted only while the owner compiles and
 * runs one of its own transaction statements, and is withdrawn when that work
 * ends, including on failure. Concurrency model: single-owner; the owner and
 * the authorizer reading this permission run synchronously on one event loop.
 */
class SqliteTransactionControl {
  /** Whether the owner is issuing its own transaction statement right now. */
  #allowed = false

  /**
   * Reports whether the connection may compile a statement with this action.
   *
   * @param actionCode - SQLite authorizer action code of the statement being
   * compiled.
   * @returns False only for a transaction-control statement compiled outside
   * the owner's own transaction work.
   */
  public isDatabaseActionAllowed(actionCode: number): boolean {
    return actionCode !== constants.SQLITE_TRANSACTION || this.#allowed
  }

  /**
   * Performs the owner's transaction work with transaction-control statements
   * permitted.
   *
   * @typeParam Result - Value produced by the work.
   * @param work - Synchronous work that begins, ends, or rolls back a
   * transaction.
   * @returns The work's result.
   * @throws The work's failure; permission is withdrawn either way.
   */
  public handleTransactionControlRequest<Result>(work: () => Result): Result {
    this.#allowed = true
    try {
      return work()
    } finally {
      this.#allowed = false
    }
  }
}

/**
 * Borrows the shared connection to compile statements for store operations.
 *
 * @remarks Exposes statement compilation only, so a store cannot close the
 * connection or run unprepared SQL. Owns no resource: its statements borrow
 * the connection, which {@link SqliteDatabase} closes. Concurrency model:
 * single-owner, confined to the database's event loop.
 * Implements {@link DatabaseStatementCompiler}.
 */
class SqliteStatementCompiler implements DatabaseStatementCompiler {
  /** Connection borrowed from the owning {@link SqliteDatabase}. */
  readonly #database: DatabaseSync

  /**
   * Retains the borrowed connection.
   *
   * @param database - Open connection whose authorizer refuses store
   * transaction control.
   */
  public constructor(database: DatabaseSync) {
    this.#database = database
  }

  /**
   * Implements {@link DatabaseStatementCompiler.createStatement}.
   *
   * @param sql - Interface-defined SQL statement.
   * @returns The interface-defined statement owned by the calling store.
   * @throws The interface-defined compilation failures.
   */
  public createStatement(sql: string): StatementSync {
    return this.#database.prepare(sql)
  }
}

/**
 * Owns the backend's single SQLite connection, its schema version and
 * durability settings, and its closure, and lends transactions to stores.
 *
 * @remarks Invariant: while open, the connection enforces foreign keys, is
 * migrated to the current schema, and compiles transaction-control statements
 * only for this owner; once closing begins, every operation fails with
 * `Database is closed` before using the connection, even if closing failed.
 * Concurrency model: single-owner. The composition root retains the instance
 * on the backend's one event loop and every operation is synchronous, so calls
 * cannot overlap; a nested call is rejected.
 * Resource ownership: owns the connection, and with it the authorizer
 * registration, through one disposal stack. Statements created by stores
 * borrow the connection and are finalized when it closes. The composition root
 * holds the only close capability; stores receive {@link DatabaseReader},
 * {@link DatabaseWriter}, and {@link DatabaseFunctionRegistry}.
 * Implements {@link DatabaseReader}, {@link DatabaseWriter}, and
 * {@link DatabaseFunctionRegistry}.
 */
export default class SqliteDatabase
  implements
    DatabaseReader,
    DatabaseWriter,
    DatabaseFunctionRegistry,
    Disposable
{
  /** Connection borrowed from the exclusively owned disposal stack. */
  readonly #database: DatabaseSync
  /** Statement-only view of the connection lent to every operation. */
  readonly #statements: SqliteStatementCompiler
  /** Permission read by the connection's authorizer, granted only by this owner. */
  readonly #transactionControl: SqliteTransactionControl
  /** Sole release owner and terminal admission guard. */
  readonly #lifetime: DisposableStack

  /**
   * Retains a prepared connection and takes over its release.
   *
   * @param database - Migrated connection borrowed from `lifetime`, whose
   * authorizer consults `transactionControl`.
   * @param transactionControl - Permission this owner grants itself for its
   * own transaction statements.
   * @param lifetime - Exclusive release obligation transferred by
   * {@link SqliteDatabase.open}.
   */
  private constructor(
    database: DatabaseSync,
    transactionControl: SqliteTransactionControl,
    lifetime: DisposableStack
  ) {
    this.#database = database
    this.#statements = new SqliteStatementCompiler(database)
    this.#transactionControl = transactionControl
    this.#lifetime = lifetime
  }

  /**
   * Opens, configures, and migrates the backend database before publishing it.
   *
   * @param databaseFilePath - SQLite location; `:memory:` opens an isolated
   * database.
   * @returns The ready database, whose closure belongs to the caller.
   * @throws If the connection cannot be opened, the stored schema version is
   * invalid or newer than supported, a migration fails, or SQLite rejects a
   * setting. The connection is closed before the failure propagates, and a
   * refused version or failed migration leaves the stored schema unchanged.
   * @remarks Enables foreign-key enforcement, applies pending migrations,
   * switches to write-ahead logging with `synchronous = NORMAL` (see
   * {@link updateDatabaseDurability}), and installs an authorizer that refuses
   * every transaction-control statement this owner does not issue itself.
   */
  public static open(databaseFilePath: PathLike): SqliteDatabase {
    using lifetime = new DisposableStack()
    const database = lifetime.use(new DatabaseSync(databaseFilePath))
    database.exec("PRAGMA foreign_keys = ON")
    migrateDatabase(database)
    updateDatabaseDurability(database)
    const transactionControl = new SqliteTransactionControl()
    database.setAuthorizer((actionCode) =>
      transactionControl.isDatabaseActionAllowed(actionCode)
        ? constants.SQLITE_OK
        : constants.SQLITE_DENY
    )
    return new SqliteDatabase(database, transactionControl, lifetime.move())
  }

  /**
   * Implements {@link DatabaseReader.handleDatabaseReadRequest} with a deferred
   * transaction that is always rolled back.
   *
   * @typeParam Result - Value produced by the operation.
   * @param operation - Interface-defined synchronous work.
   * @returns The interface-defined result.
   * @throws The interface-defined closed, nested, begin, asynchronous-operation,
   * and operation failures.
   */
  public handleDatabaseReadRequest<Result>(
    operation: DatabaseOperation<Result>
  ): Result {
    return this.#handleDatabaseTransactionRequest(
      READ_TRANSACTION_BOUNDARY,
      operation
    )
  }

  /**
   * Implements {@link DatabaseWriter.handleDatabaseWriteRequest} with an
   * immediate transaction that commits.
   *
   * @typeParam Result - Value produced by the operation.
   * @param operation - Interface-defined synchronous work.
   * @returns The interface-defined result after the commit.
   * @throws The interface-defined closed, nested, begin, asynchronous-operation,
   * operation, and commit failures.
   */
  public handleDatabaseWriteRequest<Result>(
    operation: DatabaseOperation<Result>
  ): Result {
    return this.#handleDatabaseTransactionRequest(
      WRITE_TRANSACTION_BOUNDARY,
      operation
    )
  }

  /**
   * Implements {@link DatabaseFunctionRegistry.registerDatabaseFunction} as a
   * deterministic SQLite function.
   *
   * @param name - Interface-defined SQL function name.
   * @param implementation - Interface-defined function.
   * @throws The interface-defined closed and registration failures.
   */
  public registerDatabaseFunction(
    name: string,
    implementation: DatabaseFunction
  ): void {
    this.#getOpenDatabase().function(
      name,
      { deterministic: true },
      implementation
    )
  }

  /**
   * Closes the connection once; every later operation fails with
   * `Database is closed`.
   *
   * @throws If SQLite fails to close the connection; the database still counts
   * as closed and a repeated call does not retry.
   */
  public [Symbol.dispose](): void {
    this.#lifetime.dispose()
  }

  /**
   * Returns the connection while this owner admits operations.
   *
   * @returns The open connection.
   * @throws `Database is closed` once closing has begun, including after a
   * failed close.
   */
  #getOpenDatabase(): DatabaseSync {
    if (this.#lifetime.disposed) throw new Error("Database is closed")
    return this.#database
  }

  /**
   * Runs one operation between a transaction's opening and ending statements.
   *
   * @typeParam Result - Value produced by the operation.
   * @param boundary - Statements that open and end the transaction.
   * @param operation - Synchronous work receiving statement compilation.
   * @returns The operation's result after the transaction ends.
   * @throws As documented by {@link DatabaseReader.handleDatabaseReadRequest}
   * and {@link DatabaseWriter.handleDatabaseWriteRequest}.
   */
  #handleDatabaseTransactionRequest<Result>(
    boundary: TransactionBoundary,
    operation: DatabaseOperation<Result>
  ): Result {
    const database = this.#getOpenDatabase()
    if (database.isTransaction)
      throw new Error("Database transactions cannot be nested")
    this.#transactionControl.handleTransactionControlRequest(() =>
      database.exec(boundary.begin)
    )
    try {
      const result = operation(this.#statements)
      if (isPromiseLike(result))
        throw new Error("Database operations must be synchronous")
      this.#transactionControl.handleTransactionControlRequest(() =>
        database.exec(boundary.end)
      )
      return result
    } catch (failure) {
      return this.#transactionControl.handleTransactionControlRequest(() =>
        handleTransactionFailure(database, failure)
      )
    }
  }
}

/**
 * Reports whether an operation result would settle after its transaction ends.
 *
 * @param value - Result returned by a database operation.
 * @returns True for an object or function with a callable `then` member.
 */
function isPromiseLike(value: unknown): boolean {
  if (typeof value !== "object" && typeof value !== "function") return false
  return value !== null && "then" in value && typeof value.then === "function"
}
