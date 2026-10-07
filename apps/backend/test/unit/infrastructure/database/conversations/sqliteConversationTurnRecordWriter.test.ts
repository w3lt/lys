import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import { openSqliteConversationRecords } from "../../../support/conversationDatabase"
import { createFixtureUuidV7 } from "../../../support/conversationFixtures"
import {
  registerConversationTurnRecordWriterContractSuite,
  registerConversationTurnTransactionContractSuite
} from "../../../support/conversationRecordsContract"

/** Conversation the cases store. */
const CONVERSATION_ID = createFixtureUuidV7(1)

/** Streaming reply the cases append to. */
const REPLY_ID = createFixtureUuidV7(11)

/**
 * Creates a database file location in a directory owned by the current test.
 *
 * @returns An absolute path whose directory is removed when the test finishes.
 */
function createOwnedDatabaseFilePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "lys-turn-records-test-"))
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true })
  })
  return join(directory, "lys_db.sqlite")
}

describe("SqliteConversationTurnRecordWriter", () => {
  registerConversationTurnRecordWriterContractSuite(() =>
    openSqliteConversationRecords()
  )
  registerConversationTurnTransactionContractSuite(() =>
    openSqliteConversationRecords()
  )

  it("commits each delta before returning, visible to another connection", () => {
    const databaseFilePath = createOwnedDatabaseFilePath()
    const records = openSqliteConversationRecords(databaseFilePath)
    records.saveConversation({
      id: CONVERSATION_ID,
      title: null,
      agentCode: "lys",
      createdAt: "2025-01-01T00:00:00.000Z"
    })
    records.saveAssistantMessage({
      id: REPLY_ID,
      conversationId: CONVERSATION_ID,
      model: "qwen/qwen3-8b",
      content: "",
      status: "streaming",
      finishReason: null,
      createdAt: "2025-01-01T00:00:01.000Z",
      updatedAt: "2025-01-01T00:00:01.000Z"
    })
    const observer = new DatabaseSync(databaseFilePath)
    onTestFinished(() => {
      observer.close()
    })
    const getStoredContent = () =>
      observer
        .prepare("SELECT content FROM conversation_messages WHERE id = ?")
        .get(REPLY_ID)

    records.turnRecordWriter.updateAssistantMessageContent({
      assistantMessageId: REPLY_ID,
      content: "Hel",
      updatedAt: "2025-01-01T00:00:02.000Z"
    })
    expect(getStoredContent()).toEqual({ content: "Hel" })

    records.turnRecordWriter.updateAssistantMessageContent({
      assistantMessageId: REPLY_ID,
      content: "lo",
      updatedAt: "2025-01-01T00:00:03.000Z"
    })
    expect(getStoredContent()).toEqual({ content: "Hello" })
  })

  it("fails before running a turn operation while another connection holds the write lock", () => {
    const databaseFilePath = createOwnedDatabaseFilePath()
    const records = openSqliteConversationRecords(databaseFilePath)
    const otherConnection = new DatabaseSync(databaseFilePath)
    onTestFinished(() => {
      otherConnection.close()
    })
    otherConnection.exec("BEGIN IMMEDIATE")
    const operation = vi.fn(() => "never run")

    expect(() =>
      records.turnRecordWriter.handleConversationTurnWriteRequest(operation)
    ).toThrow(/database is locked/)

    expect(operation).not.toHaveBeenCalled()
    otherConnection.exec("ROLLBACK")
  })

  it("refuses a message for a conversation that is not stored and keeps the turn's other writes out", () => {
    const records = openSqliteConversationRecords()

    expect(() =>
      records.turnRecordWriter.handleConversationTurnWriteRequest(
        (transaction) => {
          transaction.createConversation({
            id: createFixtureUuidV7(2),
            title: null,
            agentCode: "lys",
            createdAt: "2025-01-01T00:00:00.000Z",
            updatedAt: "2025-01-01T00:00:00.000Z"
          })
          transaction.createUserMessage(CONVERSATION_ID, {
            id: createFixtureUuidV7(10),
            role: "user",
            content: "Hello",
            createdAt: "2025-01-01T00:00:01.000Z"
          })
        }
      )
    ).toThrow("FOREIGN KEY constraint failed")

    expect(
      records.recordReader.listConversations({
        query: "",
        after: undefined,
        limit: 30
      }).storedCount
    ).toBe(0)
  })
})
