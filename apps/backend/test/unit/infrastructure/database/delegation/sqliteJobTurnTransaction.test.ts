import { describe, expect, it } from "vitest"
import { openSqliteConversationRecords } from "../../../support/conversationDatabase"
import { createFixtureUuidV7 } from "../../../support/conversationFixtures"
import { registerJobTurnTransactionContractSuite } from "../../../support/jobTurnTransactionContract"

describe("SqliteJobTurnTransaction", () => {
  registerJobTurnTransactionContractSuite(() => openSqliteConversationRecords())

  it("refuses a source of a conversation that is not stored with the foreign key's failure", () => {
    const records = openSqliteConversationRecords()
    const source = {
      number: 1,
      url: "https://example.com/moths/diet",
      title: "What moths eat"
    }

    expect(() =>
      records.turnRecordWriter.handleConversationTurnWriteRequest(
        (_transaction, jobs) => {
          jobs.createConversationSource(createFixtureUuidV7(999), source)
        }
      )
    ).toThrow("FOREIGN KEY constraint failed")
  })
})
