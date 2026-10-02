import { describe, expect, it, onTestFinished } from "vitest"
import SqliteConversationStore from "../../../../../src/di/services/conversationService"
import { parseConversationListOptions } from "../../../../../src/di/services/conversationService/utils"

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

  it("refuses new access objects after disposal", () => {
    const store = openOwnedStore(":memory:")
    expect(() => store.createHistoryAccess()).not.toThrow()
    expect(() => store.createTurnAccess()).not.toThrow()

    store[Symbol.dispose]()

    expect(() => store.createHistoryAccess()).toThrow()
    expect(() => store.createTurnAccess()).toThrow()
  })

  it("accepts repeated disposal", () => {
    const store = openOwnedStore(":memory:")
    store[Symbol.dispose]()

    expect(() => store[Symbol.dispose]()).not.toThrow()
  })
})
