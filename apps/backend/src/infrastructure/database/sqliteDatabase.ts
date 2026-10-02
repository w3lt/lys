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
import {
  DATABASE_WRITE_ACCESS_SQL,
  DATABASE_WRITE_PROTECTION_SQL,
  WRITE_PROTECTION_PRAGMA,
  updateDatabaseWriteProtection
} from "./writeProtection"

/** Statements that open and end one kind of owner transaction. */
type TransactionBoundary = Readonly<{
  /** Statements that open the transaction. */
  begin: "BEGIN" | `${typeof DATABASE_WRITE_ACCESS_SQL}; BEGIN IMMEDIATE`
  /** Statements that end the transaction after the operation succeeds. */
  end: "ROLLBACK" | `${typeof DATABASE_WRITE_PROTECTION_SQL}; COMMIT`
}>

/**
 * Deferred snapshot that runs under write protection, so SQLite refuses every
 * change, and ends without keeping anything.
 */
const READ_TRANSACTION_BOUNDARY: TransactionBoundary = Object.freeze({
  begin: "BEGIN",
  end: "ROLLBACK"
})

/**
 * Write transaction that lifts write protection, takes the write lock first,
 * and restores protection before it commits.
 */
const WRITE_TRANSACTION_BOUNDARY: TransactionBoundary = Object.freeze({
  begin: `${DATABASE_WRITE_ACCESS_SQL}; BEGIN IMMEDIATE`,
  end: `${DATABASE_WRITE_PROTECTION_SQL}; COMMIT`
})

/**
 * Owns the permission that lets only the database owner's own transaction and
 * write-protection statements past the connection's authorizer.
 *
 * @remarks Invariant: permission is granted only while the owner compiles and
 * runs its own transaction or write-protection statements, and returns to its
 * earlier value when that work ends, including on failure. Concurrency model:
 * single-owner; the owner and the authorizer reading this permission run
 * synchronously on one event loop.
 */
class SqliteTransactionControl {
  /** Whether the owner is issuing its own owner-only statement right now. */
  #allowed = false

  /**
   * Reports whether the connection may compile a statement with this action.
   *
   * @param actionCode - SQLite authorizer action code of the statement being
   * compiled.
   * @param firstArgument - The action's first authorizer argument, which is
   * the pragma name for a pragma.
   * @returns False only for a transaction-control statement or the
   * write-protection pragma compiled outside the owner's own work.
   */
  public isDatabaseActionAllowed(
    actionCode: number,
    firstArgument: string | null
  ): boolean {
    return this.#allowed || !isOwnerDatabaseAction(actionCode, firstArgument)
  }

  /**
   * Performs the owner's work with its owner-only statements permitted.
   *
   * @typeParam Result - Value produced by the work.
   * @param work - Synchronous work that begins, ends, or rolls back a
   * transaction, or changes write protection.
   * @returns The work's result.
   * @throws The work's failure; permission returns to its earlier value either
   * way.
   * @remarks A nested call is supported: permission stays granted until the
   * outermost call ends.
   */
  public handleTransactionControlRequest<Result>(work: () => Result): Result {
    const wasAllowed = this.#allowed
    this.#allowed = true
    try {
      return work()
    } finally {
      this.#allowed = wasAllowed
    }
  }
}

/**
 * Borrows the shared connection to compile each distinct SQL text of store
 * operations once.
 *
 * @remarks Exposes statement compilation only, so a store cannot close the
 * connection or run unprepared SQL. Invariant: it holds at most one statement
 * per SQL text and compiles only while an operation holds the connection's
 * transaction. Resource ownership: the connection and every statement are
 * borrowed; {@link SqliteDatabase} owns the connection, whose closing
 * finalizes the statements. The statements grow by one per distinct SQL text,
 * which stores keep fixed. Concurrency model: single-owner, confined to the
 * database's event loop.
 * Implements {@link DatabaseStatementCompiler}.
 */
class SqliteStatementCompiler implements DatabaseStatementCompiler {
  /** Connection borrowed from the owning {@link SqliteDatabase}. */
  readonly #database: DatabaseSync
  /**
   * Compiled statements by SQL text, borrowed from the connection, which
   * finalizes them when it closes.
   */
  readonly #statements = new Map<string, StatementSync>()

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
   * Implements {@link DatabaseStatementCompiler.createStatement}, compiling
   * the SQL text on its first request.
   *
   * @param sql - Interface-defined SQL statement.
   * @returns The interface-defined statement shared by every request of the
   * same text.
   * @throws The interface-defined closed, ended-operation, and compilation
   * failures.
   */
  public createStatement(sql: string): StatementSync {
    if (!this.#database.isOpen) throw new Error("Database is closed")
    if (!this.#database.isTransaction)
      throw new Error("Database operation has ended")
    const compiledStatement = this.#statements.get(sql)
    if (compiledStatement !== undefined) return compiledStatement
    const statement = this.#database.prepare(sql)
    this.#statements.set(sql, statement)
    return statement
  }
}

/**
 * Owns the backend's single SQLite connection, its schema version, durability
 * and write-protection settings, compiled statements, and closure, and lends
 * transactions to stores.
 *
 * @remarks Invariant: while open, the connection enforces foreign keys, is
 * migrated to the current schema, compiles transaction-control and
 * write-protection statements only for this owner, and refuses every change
 * outside a write operation; once closing begins, every operation fails with
 * `Database is closed` before using the connection, even if closing failed.
 * Concurrency model: single-owner. The composition root retains the instance
 * on the backend's one event loop and every operation is synchronous, so calls
 * cannot overlap; a nested call is rejected.
 * Resource ownership: owns the connection, and with it the authorizer
 * registration and every compiled statement, through one disposal stack;
 * closing the connection finalizes the statements. The composition root
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
  /**
   * Statement-only view of the connection, holding its compiled statements,
   * lent to every operation.
   */
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
   * own transaction and write-protection statements.
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
   * {@link updateDatabaseDurability}), turns on write protection, which only a
   * write operation lifts (see {@link updateDatabaseWriteProtection}), and
   * installs an authorizer that refuses every transaction-control and
   * write-protection statement this owner does not issue itself.
   */
  public static open(databaseFilePath: PathLike): SqliteDatabase {
    using lifetime = new DisposableStack()
    const database = lifetime.use(new DatabaseSync(databaseFilePath))
    updateDatabaseForeignKeyEnforcement(database)
    migrateDatabase(database)
    updateDatabaseDurability(database)
    updateDatabaseWriteProtection(database)
    const transactionControl = registerDatabaseTransactionAuthorizer(database)
    return new SqliteDatabase(database, transactionControl, lifetime.move())
  }

  /**
   * Implements {@link DatabaseReader.handleDatabaseReadRequest} with a deferred
   * transaction under write protection that is always rolled back.
   *
   * @typeParam Result - Value produced by the operation.
   * @param operation - Interface-defined synchronous work.
   * @returns The interface-defined result.
   * @throws The interface-defined closed, nested, begin, asynchronous-operation,
   * operation, and snapshot-release failures.
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
   * immediate transaction that lifts write protection until it commits.
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
   * @remarks A failed begin also passes through the failure handler, because
   * the write boundary lifts write protection before it takes the write lock.
   */
  #handleDatabaseTransactionRequest<Result>(
    boundary: TransactionBoundary,
    operation: DatabaseOperation<Result>
  ): Result {
    const database = this.#getOpenDatabase()
    if (database.isTransaction)
      throw new Error("Database transactions cannot be nested")
    try {
      this.#transactionControl.handleTransactionControlRequest(() =>
        database.exec(boundary.begin)
      )
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
 * Makes the connection enforce foreign-key constraints.
 *
 * @param database - Open connection, outside any transaction.
 * @throws If SQLite rejects the pragma.
 */
function updateDatabaseForeignKeyEnforcement(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = ON")
}

/**
 * Installs the authorizer that refuses every transaction-control and
 * write-protection statement the database owner does not issue itself.
 *
 * @param database - Open connection whose owner issues no such statement
 * except through the returned permission.
 * @returns The permission the authorizer consults, which the owner grants
 * itself for its own statements.
 * @throws If SQLite rejects the authorizer.
 */
function registerDatabaseTransactionAuthorizer(
  database: DatabaseSync
): SqliteTransactionControl {
  const transactionControl = new SqliteTransactionControl()
  database.setAuthorizer((actionCode, firstArgument) =>
    transactionControl.isDatabaseActionAllowed(actionCode, firstArgument)
      ? constants.SQLITE_OK
      : constants.SQLITE_DENY
  )
  return transactionControl
}

/**
 * Reports whether only the database owner may compile a statement with this
 * authorizer action.
 *
 * @param actionCode - SQLite authorizer action code.
 * @param firstArgument - The action's first authorizer argument.
 * @returns True for transaction control, savepoints, and the write-protection
 * pragma.
 */
function isOwnerDatabaseAction(
  actionCode: number,
  firstArgument: string | null
): boolean {
  return (
    isTransactionControlAction(actionCode) ||
    isWriteProtectionPragma(actionCode, firstArgument)
  )
}

/**
 * Reports whether an authorizer action begins, ends, or partially rolls back
 * a transaction.
 *
 * @param actionCode - SQLite authorizer action code.
 * @returns True for `BEGIN`, `COMMIT`, `END`, and `ROLLBACK`, and for
 * `SAVEPOINT`, `RELEASE`, and `ROLLBACK TO`.
 */
function isTransactionControlAction(actionCode: number): boolean {
  return (
    actionCode === constants.SQLITE_TRANSACTION ||
    actionCode === constants.SQLITE_SAVEPOINT
  )
}

/**
 * Reports whether an authorizer action reads or sets the write-protection
 * pragma.
 *
 * @param actionCode - SQLite authorizer action code.
 * @param pragmaName - Pragma name as written in the statement, for a pragma.
 * @returns True for the `query_only` pragma in any letter case.
 */
function isWriteProtectionPragma(
  actionCode: number,
  pragmaName: string | null
): boolean {
  return (
    actionCode === constants.SQLITE_PRAGMA &&
    pragmaName?.toLowerCase() === WRITE_PROTECTION_PRAGMA
  )
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
