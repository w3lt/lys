import { DatabaseSync } from "node:sqlite"
import type { PathLike } from "node:fs"
import { calculateConversationSearchMatch } from "./listConversations"
import { migrateDatabase } from "./migrations"
import SqliteConversationHistory from "./history"
import SqliteConversationTurns from "./turns"

/** Borrows the open database for one synchronous operation; throws after disposal. */
export type GetConversationDatabase = () => DatabaseSync

/**
 * Owns one SQLite connection and the lifetime of its borrowed history and turn access.
 *
 * @remarks Single-owner, synchronous operations complete before another event-loop
 * callback runs. Callers must finish active requests before disposing the store.
 * Borrowers cannot close the database and reject every operation after disposal.
 */
export default class SqliteConversationStore {
  /** Database borrowed from the exclusively owned disposal stack. */
  readonly #database: DatabaseSync
  /** Sole release owner and terminal admission guard. */
  readonly #lifetime: DisposableStack

  /**
   * Retains a ready database and transfers its protected lifetime.
   * @param database - Migrated connection borrowed from lifetime.
   * @param lifetime - Exclusive cleanup obligation transferred by open.
   */
  private constructor(database: DatabaseSync, lifetime: DisposableStack) {
    this.#database = database
    this.#lifetime = lifetime
  }

  /**
   * Opens, migrates, and recovers a conversation database before publishing it.
   * @param databaseFilePath - SQLite location; :memory: creates an isolated store.
   * @returns The ready store whose disposal belongs to the caller.
   * @throws If acquisition, migration, or recovery fails; acquired resources are released.
   */
  public static open(databaseFilePath: PathLike): SqliteConversationStore {
    using lifetime = new DisposableStack()
    const database = lifetime.use(new DatabaseSync(databaseFilePath))
    database.exec("PRAGMA foreign_keys = ON")
    database.function(
      "contains_search",
      { deterministic: true },
      calculateConversationSearchMatch
    )
    migrateDatabase(database)
    database
      .prepare(
        `UPDATE conversation_messages SET status = 'interrupted', updated_at = ?
      WHERE role = 'assistant' AND status = 'streaming'`
      )
      .run(new Date().toISOString())
    return new SqliteConversationStore(database, lifetime.move())
  }

  /**
   * Creates history access borrowing this store's guarded lifetime.
   * @returns An adapter valid until this store is disposed; it cannot release the store.
   * @throws If the store is closed.
   */
  public createHistoryAccess(): SqliteConversationHistory {
    this.#getDatabase()
    return new SqliteConversationHistory(() => this.#getDatabase())
  }

  /**
   * Creates turn persistence access borrowing this store's guarded lifetime.
   * @returns An adapter valid until this store is disposed; it cannot release the store.
   * @throws If the store is closed.
   */
  public createTurnAccess(): SqliteConversationTurns {
    this.#getDatabase()
    return new SqliteConversationTurns(() => this.#getDatabase())
  }

  /**
   * Borrows the connection only while its sole owner admits operations.
   * @returns The open connection for synchronous use by a borrower.
   * @throws If disposal has begun, including after a failed release.
   */
  #getDatabase(): DatabaseSync {
    if (this.#lifetime.disposed) throw new Error("Conversation store is closed")
    return this.#database
  }

  /** Releases the connection once; all borrowed access becomes terminally closed. */
  public [Symbol.dispose](): void {
    this.#lifetime.dispose()
  }
}
