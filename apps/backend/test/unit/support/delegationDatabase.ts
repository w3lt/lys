import SqliteJobActivityReader from "../../../src/infrastructure/database/delegation/sqliteJobActivityReader"
import SqliteJobReader from "../../../src/infrastructure/database/delegation/sqliteJobReader"
import SqliteJobReportWriter from "../../../src/infrastructure/database/delegation/sqliteJobReportWriter"
import {
  listJobReportRows,
  openTestDatabase,
  saveAssistantMessageRow,
  saveConversationRow,
  saveJobReportRow,
  saveUserMessageRow
} from "./conversationDatabase"
import type { DelegationRecordsHarness } from "./delegationRecordsContract"

/**
 * Creates the Sqlite job records over their own in-memory backend database,
 * owned by the current test.
 *
 * @returns The records, row-level seeding and listing of the same database,
 * and its close. The database is closed when the test finishes.
 */
export function openSqliteDelegationRecords(): DelegationRecordsHarness {
  const database = openTestDatabase()
  return {
    jobReader: new SqliteJobReader(database),
    jobActivityReader: new SqliteJobActivityReader(database),
    jobReportWriter: new SqliteJobReportWriter(database),
    saveConversation: (row) => {
      saveConversationRow(database, row)
    },
    saveUserMessage: (row) => {
      saveUserMessageRow(database, row)
    },
    saveAssistantMessage: (row) => {
      saveAssistantMessageRow(database, row)
    },
    saveJobReport: (row) => {
      saveJobReportRow(database, row)
    },
    listJobReports: () => listJobReportRows(database),
    closeRecords: () => {
      database[Symbol.dispose]()
    }
  }
}
