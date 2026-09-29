import type { SqliteTransactions } from "../../../infrastructure/database/sqliteDatabase"
import { calculateConversationSearchMatch } from "./listConversations"
import SqliteConversationHistory from "./history"
import SqliteConversationTurns from "./turns"

/**
 * Prepares conversation persistence on the shared SQLite database and lends
 * its history and turn access.
 *
 * @remarks Owns no resource. The composition root owns the database and closes
 * it after active requests settle; every adapter call fails after that
 * closure. Single-owner, synchronous operations complete before another
 * event-loop callback runs.
 */
export default class SqliteConversationStore {
  /** Borrowed transactional access; carries no authority to close the database. */
  readonly #database: SqliteTransactions

  /**
   * Retains the shared database after conversation setup has completed.
   * @param database - Transactional access prepared by
   * {@link SqliteConversationStore.create}.
   */
  private constructor(database: SqliteTransactions) {
    this.#database = database
  }

  /**
   * Installs conversation search and recovers interrupted replies before
   * publishing the store.
   * @param database - Migrated shared database borrowed for the store's lifetime.
   * @returns The ready store.
   * @throws If the database is closed or recovery fails; the recovery update is
   * rolled back.
   * @remarks Registers the `contains_search` SQL function on the shared
   * connection. Recovery marks replies left streaming as interrupted without
   * changing their conversations' activity time or history order.
   */
  public static create(database: SqliteTransactions): SqliteConversationStore {
    database.write((queries) => {
      queries.function(
        "contains_search",
        { deterministic: true },
        calculateConversationSearchMatch
      )
      queries
        .prepare(
          `UPDATE conversation_messages SET status = 'interrupted', updated_at = ?
      WHERE role = 'assistant' AND status = 'streaming'`
        )
        .run(new Date().toISOString())
    })
    return new SqliteConversationStore(database)
  }

  /**
   * Creates history access borrowing the shared database.
   * @returns An adapter whose calls fail after the database closes; it cannot
   * close the database.
   */
  public createHistoryAccess(): SqliteConversationHistory {
    return new SqliteConversationHistory(this.#database)
  }

  /**
   * Creates turn persistence access borrowing the shared database.
   * @returns An adapter whose calls fail after the database closes; it cannot
   * close the database.
   */
  public createTurnAccess(): SqliteConversationTurns {
    return new SqliteConversationTurns(this.#database)
  }
}
