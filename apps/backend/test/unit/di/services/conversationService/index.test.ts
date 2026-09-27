import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it, onTestFinished } from "vitest"
import SqliteConversationStore from "../../../../../src/di/services/conversationService"
import { parseConversationListOptions } from "../../../../../src/di/services/conversationService/utils"

/**
 * Allocates a database path in a temporary directory owned by the current test.
 *
 * @returns A path whose directory is removed when the test finishes.
 */
async function allocateDatabaseFilePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "lys-conversation-store-"))
  onTestFinished(async () => {
    await rm(directory, { recursive: true, force: true })
  })
  return join(directory, "conversations.sqlite")
}

/**
 * Opens a store owned by the current test.
 *
 * @param databaseFilePath - SQLite location to open.
 * @returns The ready store, disposed when the test finishes; disposal is
 * idempotent, so a case may also dispose it earlier.
 */
function openOwnedStore(databaseFilePath: string): SqliteConversationStore {
  const store = SqliteConversationStore.open(databaseFilePath)
  onTestFinished(() => {
    store[Symbol.dispose]()
  })
  return store
}

describe("SqliteConversationStore", () => {
  it("opens a ready in-memory store whose turn and history access share one database", () => {
    const store = openOwnedStore(":memory:")

    const turn = store.createTurnAccess().createConversationTurn({
      userMessageContent: "Hello",
      model: "qwen/qwen3-8b",
      systemPrompt: "You are Lys."
    })

    expect(
      store.createHistoryAccess().getConversation(turn.conversation.id)
    ).toMatchObject({ id: turn.conversation.id, systemPrompt: "You are Lys." })
  })

  it("isolates separately opened in-memory stores", () => {
    const first = openOwnedStore(":memory:")
    const second = openOwnedStore(":memory:")

    first.createTurnAccess().createConversationTurn({
      userMessageContent: "Hello",
      model: "qwen/qwen3-8b",
      systemPrompt: "You are Lys."
    })

    expect(
      second
        .createHistoryAccess()
        .listConversations(parseConversationListOptions()).storedCount
    ).toBe(0)
  })

  it("provides case-insensitive search to history queries", () => {
    const store = openOwnedStore(":memory:")
    store.createTurnAccess().createConversationTurn({
      userMessageContent: "Plan the TRIP",
      model: "qwen/qwen3-8b",
      systemPrompt: "You are Lys."
    })

    expect(
      store
        .createHistoryAccess()
        .listConversations(parseConversationListOptions({ query: "trip" }))
        .matchCount
    ).toBe(1)
  })

  it("marks replies left streaming as interrupted when reopened, keeping activity time", async () => {
    const databaseFilePath = await allocateDatabaseFilePath()
    const firstStore = openOwnedStore(databaseFilePath)
    const turns = firstStore.createTurnAccess()
    const turn = turns.createConversationTurn({
      userMessageContent: "Hello",
      model: "qwen/qwen3-8b",
      systemPrompt: "You are Lys."
    })
    turns.updateAssistantMessageContent(turn.assistantMessage.id, "Partial")
    const beforeRecovery = firstStore
      .createHistoryAccess()
      .getConversation(turn.conversation.id)
    firstStore[Symbol.dispose]()

    const reopened = openOwnedStore(databaseFilePath)

    const recovered = reopened
      .createHistoryAccess()
      .getConversation(turn.conversation.id)
    expect(recovered?.messages[1]).toMatchObject({
      id: turn.assistantMessage.id,
      content: "Partial",
      status: "interrupted",
      finishReason: null
    })
    expect(recovered?.updatedAt).toBe(beforeRecovery?.updatedAt)
  })

  it("does not change finalized replies when reopened", async () => {
    const databaseFilePath = await allocateDatabaseFilePath()
    const firstStore = openOwnedStore(databaseFilePath)
    const turns = firstStore.createTurnAccess()
    const turn = turns.createConversationTurn({
      userMessageContent: "Hello",
      model: "qwen/qwen3-8b",
      systemPrompt: "You are Lys."
    })
    turns.updateAssistantMessageState(turn.assistantMessage.id, {
      status: "completed",
      finishReason: "stop"
    })
    const beforeReopen = firstStore
      .createHistoryAccess()
      .getConversation(turn.conversation.id)
    firstStore[Symbol.dispose]()

    const reopened = openOwnedStore(databaseFilePath)

    expect(
      reopened.createHistoryAccess().getConversation(turn.conversation.id)
    ).toEqual(beforeReopen)
  })

  it("refuses to open a database created by a newer schema version", async () => {
    const databaseFilePath = await allocateDatabaseFilePath()
    const newerDatabase = new DatabaseSync(databaseFilePath)
    newerDatabase.exec("PRAGMA user_version = 99")
    newerDatabase.close()

    expect(() => SqliteConversationStore.open(databaseFilePath)).toThrow(
      "Database version 99 is newer than supported version 5"
    )
  })

  it("refuses new access objects after disposal", () => {
    const store = openOwnedStore(":memory:")

    store[Symbol.dispose]()

    expect(() => store.createHistoryAccess()).toThrow(
      "Conversation store is closed"
    )
    expect(() => store.createTurnAccess()).toThrow(
      "Conversation store is closed"
    )
  })

  it("accepts repeated disposal", () => {
    const store = openOwnedStore(":memory:")
    store[Symbol.dispose]()

    expect(() => store[Symbol.dispose]()).not.toThrow()
  })
})
