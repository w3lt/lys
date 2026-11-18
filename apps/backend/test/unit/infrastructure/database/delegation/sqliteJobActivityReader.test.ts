import { describe, expect, it } from "vitest"
import SqliteJobActivityReader from "../../../../../src/infrastructure/database/delegation/sqliteJobActivityReader"
import { openTestDatabase } from "../../../support/conversationDatabase"
import { createFixtureUuidV7 } from "../../../support/conversationFixtures"
import { openSqliteDelegationRecords } from "../../../support/delegationDatabase"
import { registerJobActivityReaderContractSuite } from "../../../support/delegationRecordsContract"

/** Conversation, or reply, the nested reads address; nothing needs to be
 * stored. */
const MAIN_ID = createFixtureUuidV7(1)

describe("SqliteJobActivityReader", () => {
  registerJobActivityReaderContractSuite(() => openSqliteDelegationRecords())

  it.for([
    [
      "hasUndeliveredWakingReport",
      (reader: SqliteJobActivityReader) =>
        reader.hasUndeliveredWakingReport(MAIN_ID)
    ],
    [
      "hasStreamingReply",
      (reader: SqliteJobActivityReader) => reader.hasStreamingReply(MAIN_ID)
    ],
    [
      "listStreamingReplies",
      (reader: SqliteJobActivityReader) => reader.listStreamingReplies(MAIN_ID)
    ],
    [
      "findEndedReply",
      (reader: SqliteJobActivityReader) => reader.findEndedReply(MAIN_ID)
    ]
  ] as const)(
    "refuses %s nested in another database operation",
    ([, readActivity]) => {
      const database = openTestDatabase()
      const jobActivityReader = new SqliteJobActivityReader(database)

      database.handleDatabaseWriteRequest(() => {
        expect(() => readActivity(jobActivityReader)).toThrow(
          "Database transactions cannot be nested"
        )
      })
    }
  )
})
