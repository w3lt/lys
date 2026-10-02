import type { ListConversationsApiResponse } from "@lys/protocol"
import type { Conversation } from "@lys/share"
import type { DatabaseReader } from "../../../infrastructure/database/databaseTransactions"
import type {
  ConversationReader,
  ConversationLister
} from "../../../modules/conversation/capabilities"
import { getConversation } from "./readConversation"
import { listConversations } from "./listConversations"
import type { ConversationListOptions } from "./utils"

/**
 * Borrows the shared database's read snapshots to observe conversation
 * history.
 *
 * @remarks Owns no resource: the database's owner closes the connection, after
 * which every operation fails with `Database is closed`. Each call is one read
 * snapshot; returned records are independent copies. Concurrency model:
 * single-owner, synchronous on the backend's event loop.
 */
export default class SqliteConversationHistoryReader
  implements ConversationReader, ConversationLister
{
  /** Borrowed read snapshots for conversation and list queries. */
  readonly #databaseReader: DatabaseReader

  /**
   * Retains borrowed read access without performing database work.
   * @param databaseReader - Read snapshots lent by the database owner.
   */
  public constructor(databaseReader: DatabaseReader) {
    this.#databaseReader = databaseReader
  }

  /**
   * Reads one conversation and its ordered transcript in one snapshot.
   * @param conversationId - Validated UUIDv7 to address.
   * @returns The stored conversation or undefined when absent.
   * @throws If the database is closed, SQLite fails, or stored data are invalid.
   */
  public getConversation(conversationId: string): Conversation | undefined {
    return this.#databaseReader.handleDatabaseReadRequest((statements) =>
      getConversation(statements, conversationId)
    )
  }

  /**
   * Lists search matches and previews from one read snapshot.
   * @param options - Validated query and cursor from parseConversationListOptions.
   * @returns A strict page in descending activity-time and UUID order.
   * @throws If the database is closed, SQLite fails, or persisted rows are invalid.
   */
  public listConversations(
    options: ConversationListOptions
  ): ListConversationsApiResponse {
    return this.#databaseReader.handleDatabaseReadRequest((statements) =>
      listConversations(statements, options)
    )
  }
}
