import SqliteAgentRecordStore from "../../../src/infrastructure/database/agents/sqliteAgentRecordStore"
import type SqliteDatabase from "../../../src/infrastructure/database/sqliteDatabase"
import type { AgentRecordStoreHarness } from "./agentRecordStoreContract"
import { openTestDatabase } from "./conversationDatabase"

/**
 * Creates the Sqlite agent records over their own in-memory backend database,
 * owned by the current test.
 *
 * @returns The records, the database they borrow for row-level checks, and
 * its close. The database is closed when the test finishes.
 */
export function openSqliteAgentRecordStore(): AgentRecordStoreHarness &
  Readonly<{ database: SqliteDatabase }> {
  const database = openTestDatabase()
  return {
    database,
    recordStore: new SqliteAgentRecordStore(database),
    closeRecords: () => {
      database[Symbol.dispose]()
    }
  }
}
