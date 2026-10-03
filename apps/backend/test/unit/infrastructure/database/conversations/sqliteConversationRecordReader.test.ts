import { describe, expect, it } from "vitest"
import SqliteConversationRecordReader from "../../../../../src/infrastructure/database/conversations/sqliteConversationRecordReader"
import SqliteDatabase from "../../../../../src/infrastructure/database/sqliteDatabase"
import {
  openSqliteConversationRecords,
  openTestDatabase
} from "../../../support/conversationDatabase"
import { registerConversationRecordReaderContractSuite } from "../../../support/conversationRecordsContract"

describe("SqliteConversationRecordReader", () => {
  registerConversationRecordReaderContractSuite(() =>
    openSqliteConversationRecords()
  )

  describe("create", () => {
    it("registers case-insensitive conversation search on the shared connection", () => {
      const database = openTestDatabase()

      SqliteConversationRecordReader.create(database)

      expect(
        database.handleDatabaseReadRequest((statements) =>
          statements
            .getStatement(
              "SELECT contains_search('Plan the TRIP', 'trip') AS match"
            )
            .get()
        )
      ).toEqual({ match: 1 })
    })

    it("refuses a closed database", () => {
      const database = SqliteDatabase.open(":memory:")
      database[Symbol.dispose]()

      expect(() => SqliteConversationRecordReader.create(database)).toThrow(
        "Database is closed"
      )
    })
  })
})
