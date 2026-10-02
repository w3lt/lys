import type {
  DatabaseFunctionRegistry,
  DatabaseReader,
  DatabaseWriter
} from "../../../infrastructure/database/databaseTransactions"
import { calculateConversationSearchMatch } from "./listConversations"
import SqliteConversationHistoryEditor from "./historyEditor"
import SqliteConversationHistoryReader from "./historyReader"
import SqliteConversationTurns from "./turns"

/** Shared-database capabilities the conversation store borrows. */
export type ConversationStoreDependencies = Readonly<{
  /** Read snapshots for history queries. */
  databaseReader: DatabaseReader
  /** Write transactions for turns, edits, deletion, and startup recovery. */
  databaseWriter: DatabaseWriter
  /** Registration of the conversation search function on the shared connection. */
  databaseFunctionRegistry: DatabaseFunctionRegistry
}>

/**
 * Provides conversation history reading, history editing, and turn access over
 * the shared backend database.
 *
 * @remarks Invariant: once created, `contains_search` is registered and no
 * reply left by an earlier process is still marked streaming. Owns no
 * resource: it borrows the database's capabilities, whose owner closes the
 * connection, after which every access operation fails with
 * `Database is closed`. Concurrency model: single-owner, synchronous on the
 * backend's event loop.
 */
export default class SqliteConversationStore {
  /** Borrowed read snapshots handed to history readers. */
  readonly #databaseReader: DatabaseReader
  /** Borrowed write transactions handed to history editors and turn access. */
  readonly #databaseWriter: DatabaseWriter

  /**
   * Retains borrowed database access prepared by {@link SqliteConversationStore.create}.
   * @param databaseReader - Read snapshots lent by the database owner.
   * @param databaseWriter - Write transactions lent by the database owner.
   */
  private constructor(
    databaseReader: DatabaseReader,
    databaseWriter: DatabaseWriter
  ) {
    this.#databaseReader = databaseReader
    this.#databaseWriter = databaseWriter
  }

  /**
   * Prepares the shared database for conversations and publishes the store.
   * @param dependencies - Capabilities borrowed from the open shared database.
   * @returns The ready store; it owns nothing to release.
   * @throws If the database is closed, the search function cannot be
   * registered, or recovery fails; a failed recovery changes nothing.
   * @remarks Registers `contains_search` for history search, then, in one write
   * transaction, marks replies left streaming as interrupted without changing
   * their conversations' activity time or history order.
   */
  public static create({
    databaseReader,
    databaseWriter,
    databaseFunctionRegistry
  }: ConversationStoreDependencies): SqliteConversationStore {
    databaseFunctionRegistry.registerDatabaseFunction(
      "contains_search",
      calculateConversationSearchMatch
    )
    databaseWriter.handleDatabaseWriteRequest((statements) =>
      statements
        .createStatement(
          `UPDATE conversation_messages SET status = 'interrupted', updated_at = ?
      WHERE role = 'assistant' AND status = 'streaming'`
        )
        .run(new Date().toISOString())
    )
    return new SqliteConversationStore(databaseReader, databaseWriter)
  }

  /**
   * Creates read access to conversation history over the shared database.
   * @returns An adapter whose operations fail with `Database is closed` after
   * the database closes; it can neither change nor close the database.
   */
  public createHistoryReader(): SqliteConversationHistoryReader {
    return new SqliteConversationHistoryReader(this.#databaseReader)
  }

  /**
   * Creates edit access to conversation history over the shared database.
   * @returns An adapter whose operations fail with `Database is closed` after
   * the database closes; it cannot close the database.
   */
  public createHistoryEditor(): SqliteConversationHistoryEditor {
    return new SqliteConversationHistoryEditor(this.#databaseWriter)
  }

  /**
   * Creates turn persistence access over the shared database.
   * @returns An adapter whose operations fail with `Database is closed` after
   * the database closes; it cannot close the database.
   */
  public createTurnAccess(): SqliteConversationTurns {
    return new SqliteConversationTurns(this.#databaseWriter)
  }
}
