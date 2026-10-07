import { describe, expect, it } from "vitest"
import * as z from "zod"
import { openSqliteConversationRecords } from "../../../support/conversationDatabase"
import { createFixtureUuidV7 } from "../../../support/conversationFixtures"
import { registerConversationRecordEditorContractSuite } from "../../../support/conversationRecordsContract"

describe("SqliteConversationRecordEditor", () => {
  registerConversationRecordEditorContractSuite(() =>
    openSqliteConversationRecords()
  )

  it("rolls a rename back when the renamed row violates the metadata contract", () => {
    const records = openSqliteConversationRecords()
    const conversationId = createFixtureUuidV7(1)
    records.saveConversation({
      id: conversationId,
      title: "Kept",
      agentCode: "Not an agent code",
      createdAt: "2025-01-01T00:00:00.000Z"
    })

    expect(() =>
      records.recordEditor.updateConversationTitle(conversationId, "Renamed")
    ).toThrow(z.ZodError)

    expect(
      records.database.handleDatabaseReadRequest((statements) =>
        statements
          .getStatement("SELECT title FROM conversations WHERE id = ?")
          .get(conversationId)
      )
    ).toEqual({ title: "Kept" })
  })
})
