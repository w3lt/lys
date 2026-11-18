import { describe, expect, it } from "vitest"
import SqliteConversationRecordReader from "../../../../../src/infrastructure/database/conversations/sqliteConversationRecordReader"
import SqliteDatabase from "../../../../../src/infrastructure/database/sqliteDatabase"
import {
  openSqliteConversationRecords,
  openTestDatabase
} from "../../../support/conversationDatabase"
import { createFixtureUuidV7 } from "../../../support/conversationFixtures"
import {
  registerConversationRecordReaderContractSuite,
  type ConversationRecordsHarness
} from "../../../support/conversationRecordsContract"

/**
 * Saves main conversation "Trip plan" of agent `caliginia`, created at
 * 2025-01-01T00:00:00.000Z, with two user messages and nothing else: fixture
 * UUIDv7 10, "Plan my trip", one second later, and fixture UUIDv7 11, "Make it
 * three days", two seconds later. No row names a parent, job number,
 * delegator, origin, or report.
 *
 * @param records - Records of the case, which store the rows.
 * @param conversationId - UUIDv7 of the conversation.
 */
function saveTripPlanConversation(
  records: Pick<
    ConversationRecordsHarness,
    "saveConversation" | "saveUserMessage"
  >,
  conversationId: string
): void {
  records.saveConversation({
    id: conversationId,
    title: "Trip plan",
    agentCode: "caliginia",
    createdAt: "2025-01-01T00:00:00.000Z"
  })
  records.saveUserMessage({
    id: createFixtureUuidV7(10),
    conversationId,
    content: "Plan my trip",
    createdAt: "2025-01-01T00:00:01.000Z"
  })
  records.saveUserMessage({
    id: createFixtureUuidV7(11),
    conversationId,
    content: "Make it three days",
    createdAt: "2025-01-01T00:00:02.000Z"
  })
}

describe("SqliteConversationRecordReader", () => {
  registerConversationRecordReaderContractSuite(() =>
    openSqliteConversationRecords()
  )

  describe("findConversation", () => {
    it("reads a stored main conversation with no parent, job number, delegator, or jobs, and each user message as the person's without reports", () => {
      const records = openSqliteConversationRecords()
      const conversationId = createFixtureUuidV7(1)
      saveTripPlanConversation(records, conversationId)

      expect(records.recordReader.findConversation(conversationId)).toEqual({
        id: conversationId,
        title: "Trip plan",
        agentCode: "caliginia",
        kind: "main",
        parentConversationId: null,
        jobNumber: null,
        delegatorAgentCode: null,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:02.000Z",
        messages: [
          {
            id: createFixtureUuidV7(10),
            role: "user",
            content: "Plan my trip",
            attachments: [],
            origin: "person",
            reports: [],
            createdAt: "2025-01-01T00:00:01.000Z"
          },
          {
            id: createFixtureUuidV7(11),
            role: "user",
            content: "Make it three days",
            attachments: [],
            origin: "person",
            reports: [],
            createdAt: "2025-01-01T00:00:02.000Z"
          }
        ],
        sources: [],
        jobs: []
      })
    })
  })

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
