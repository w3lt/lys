import { describe, expect, it } from "vitest"
import SqliteJobReader from "../../../../../src/infrastructure/database/delegation/sqliteJobReader"
import { openTestDatabase } from "../../../support/conversationDatabase"
import { createFixtureUuidV7 } from "../../../support/conversationFixtures"
import { openSqliteDelegationRecords } from "../../../support/delegationDatabase"
import { registerJobReaderContractSuite } from "../../../support/delegationRecordsContract"

/** Conversation the nested reads address; nothing needs to be stored. */
const MAIN_ID = createFixtureUuidV7(1)

describe("SqliteJobReader", () => {
  registerJobReaderContractSuite(() => openSqliteDelegationRecords())

  it.for([
    ["listJobs", (reader: SqliteJobReader) => reader.listJobs(MAIN_ID)],
    ["findJob", (reader: SqliteJobReader) => reader.findJob(MAIN_ID)],
    [
      "findJobByNumber",
      (reader: SqliteJobReader) => reader.findJobByNumber(MAIN_ID, 1)
    ],
    [
      "getJobMessageCountSincePersonMessage",
      (reader: SqliteJobReader) =>
        reader.getJobMessageCountSincePersonMessage(MAIN_ID)
    ]
  ] as const)(
    "refuses %s nested in another database operation",
    ([, readJobs]) => {
      const database = openTestDatabase()
      const jobReader = new SqliteJobReader(database)

      database.handleDatabaseWriteRequest(() => {
        expect(() => readJobs(jobReader)).toThrow(
          "Database transactions cannot be nested"
        )
      })
    }
  )
})
