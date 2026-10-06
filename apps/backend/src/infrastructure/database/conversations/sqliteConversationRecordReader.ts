import type {
  ConversationPage,
  ConversationRecordReader,
  ListConversationsInput
} from "../../../modules/conversation/records"
import type {
  DatabaseFunctionRegistry,
  DatabaseReader
} from "../databaseTransactions"
import type { Conversation } from "@lys/share"
import { calculateConversationSearchMatch } from "./conversationSearch"
import { findConversation } from "./findConversation"
import { listConversations } from "./listConversations"

/**
 * Borrows the shared database's read snapshots to read stored conversation
 * history.
 *
 * @remarks Invariant: once created, `contains_search` is registered on the
 * shared connection for its list queries. Owns no resource: the database's
 * owner closes the connection, after which every operation fails with
 * `Database is closed`. Each call is one read snapshot; returned records are
 * independent copies. Concurrency model: single-owner, synchronous on the
 * backend's event loop. Implements {@link ConversationRecordReader}.
 */
export default class SqliteConversationRecordReader implements ConversationRecordReader {
  /** Borrowed read snapshots for conversation and list queries. */
  readonly #databaseReader: DatabaseReader

  /**
   * Retains borrowed read access prepared by
   * {@link SqliteConversationRecordReader.create}.
   * @param databaseReader - Read snapshots lent by the database owner.
   */
  private constructor(databaseReader: DatabaseReader) {
    this.#databaseReader = databaseReader
  }

  /**
   * Registers conversation search on the shared connection and publishes read
   * access to stored conversations.
   * @param database - Read snapshots and function registration lent by the
   * database owner; the records retain only the read snapshots.
   * @returns The ready records; they own nothing to release.
   * @throws If the database is closed or SQLite rejects the registration.
   * @remarks Registers `contains_search`, the case-insensitive match used by
   * history search, replacing a function already registered under that name.
   */
  public static create(
    database: DatabaseReader & DatabaseFunctionRegistry
  ): SqliteConversationRecordReader {
    database.registerDatabaseFunction(
      "contains_search",
      calculateConversationSearchMatch
    )
    return new SqliteConversationRecordReader(database)
  }

  /**
   * Implements {@link ConversationRecordReader.findConversation} in one read
   * snapshot.
   * @param conversationId - Interface-defined identity.
   * @returns The interface-defined conversation or absence.
   * @throws The interface-defined closed and validation failures.
   */
  public findConversation(conversationId: string): Conversation | undefined {
    return this.#databaseReader.handleDatabaseReadRequest((statements) =>
      findConversation(statements, conversationId)
    )
  }

  /**
   * Implements {@link ConversationRecordReader.listConversations} in one read
   * snapshot.
   * @param input - Interface-defined search text, page boundary, and page
   * size.
   * @returns The interface-defined page.
   * @throws The interface-defined closed and validation failures.
   */
  public listConversations(input: ListConversationsInput): ConversationPage {
    return this.#databaseReader.handleDatabaseReadRequest((statements) =>
      listConversations(statements, input)
    )
  }
}
