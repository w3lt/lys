import SqliteAgentRecordStore from "../../../src/infrastructure/database/agents/sqliteAgentRecordStore"
import type SqliteDatabase from "../../../src/infrastructure/database/sqliteDatabase"
import type { AgentRecordSearcherHarness } from "./agentRecordStoreContract"
import { openTestDatabase } from "./conversationDatabase"

/**
 * Creates the Sqlite agent records over their own in-memory backend database,
 * owned by the current test.
 *
 * @returns The Sqlite records, the same records as their search, the
 * database they borrow for row-level checks, and its close. The database is
 * closed when the test finishes.
 */
export function openSqliteAgentRecordStore(): AgentRecordSearcherHarness &
  Readonly<{ database: SqliteDatabase; recordStore: SqliteAgentRecordStore }> {
  const database = openTestDatabase()
  const recordStore = SqliteAgentRecordStore.create(database)
  return {
    database,
    recordStore,
    recordSearcher: recordStore,
    closeRecords: () => {
      database[Symbol.dispose]()
    }
  }
}
