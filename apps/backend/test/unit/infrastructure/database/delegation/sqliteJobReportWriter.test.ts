import { describe, expect, it, onTestFinished } from "vitest"
import SqliteJobReportWriter from "../../../../../src/infrastructure/database/delegation/sqliteJobReportWriter"
import {
  listJobReportRows,
  openTestDatabase
} from "../../../support/conversationDatabase"
import { createFixtureUuidV7 } from "../../../support/conversationFixtures"
import { openSqliteDelegationRecords } from "../../../support/delegationDatabase"
import { registerJobReportWriterContractSuite } from "../../../support/delegationRecordsContract"

describe("SqliteJobReportWriter", () => {
  registerJobReportWriterContractSuite(() => openSqliteDelegationRecords())

  it("refuses report writes nested in another database operation and stores nothing", () => {
    const database = openTestDatabase()
    onTestFinished(() => {
      database[Symbol.dispose]()
    })
    const jobReportWriter = new SqliteJobReportWriter(database)
    const report = {
      id: createFixtureUuidV7(30),
      jobId: createFixtureUuidV7(10),
      replyId: createFixtureUuidV7(20),
      title: "Find what moths eat",
      createdAt: "2026-03-04T05:06:07.890Z"
    }

    database.handleDatabaseReadRequest(() => {
      expect(() =>
        jobReportWriter.createEndReport({
          ...report,
          kind: "result",
          content: "Moths drink nectar."
        })
      ).toThrow("Database transactions cannot be nested")
      expect(() =>
        jobReportWriter.createProgressNote({
          ...report,
          content: "Reading three feeds."
        })
      ).toThrow("Database transactions cannot be nested")
    })

    expect(listJobReportRows(database)).toEqual([])
  })
})
