import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it, onTestFinished } from "vitest"
import { openSqliteConversationRecords } from "../../../support/conversationDatabase"
import {
  createFixtureUuidV7,
  createTextPart
} from "../../../support/conversationFixtures"
import { registerReplyPartRecordWriterContractSuite } from "../../../support/conversationRecordsContract"

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
  const directory = mkdtempSync(join(tmpdir(), "lys-reply-part-records-test-"))
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true })
  })
  return join(directory, "lys_db.sqlite")
}

describe("SqliteReplyPartRecordWriter", () => {
  registerReplyPartRecordWriterContractSuite(() =>
    openSqliteConversationRecords()
  )

  it("commits each fragment before returning, visible to another connection", () => {
    const databaseFilePath = createOwnedDatabaseFilePath()
    const records = openSqliteConversationRecords(databaseFilePath)
    records.saveConversation({
      id: CONVERSATION_ID,
      title: null,
      agentCode: "lys",
      createdAt: "2025-01-01T00:00:00.000Z"
    })
    const part = createTextPart(12, 0, "Hel")
    records.saveAssistantMessage({
      id: REPLY_ID,
      conversationId: CONVERSATION_ID,
      model: "qwen/qwen3-8b",
      parts: [part],
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
        .get(part.id)

    records.replyPartRecordWriter.updateReplyPartContent({
      assistantMessageId: REPLY_ID,
      partId: part.id,
      content: "lo",
      updatedAt: "2026-01-03T00:00:00.000Z"
    })
    expect(getStoredContent()).toEqual({ content: "Hello" })

    records.replyPartRecordWriter.updateReplyPartContent({
      assistantMessageId: REPLY_ID,
      partId: part.id,
      content: "!",
      updatedAt: "2026-01-03T00:00:01.000Z"
    })
    expect(getStoredContent()).toEqual({ content: "Hello!" })
  })
})
