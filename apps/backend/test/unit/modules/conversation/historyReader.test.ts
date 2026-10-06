import { describe, expect, it } from "vitest"
import * as z from "zod"
import StoredConversationHistoryReader from "../../../../src/modules/conversation/historyReader"
import { parseConversationListOptions } from "../../../../src/modules/conversation/listOptions"
import {
  openConversationTestServices,
  openSqliteConversationRecords
} from "../../support/conversationDatabase"
import { createFixtureUuidV7 } from "../../support/conversationFixtures"

/**
 * Opens isolated in-memory conversation services with one committed turn.
 *
 * @returns The test-owned database, turn access, history reader, and the
 * committed turn.
 */
function openHistoryWithTurn() {
  const { database, turns, history } = openConversationTestServices()
  const turn = turns.createConversationTurn({
    userMessageContent: "Plan the TRIP",
    model: "qwen/qwen3-8b",
    systemPrompt: "You are Lys."
  })
  return { database, turns, history, turn }
}

/**
 * Creates a history reader over records holding three conversations with the
 * same activity time.
 *
 * @returns The reader and the stored identities in ascending order.
 */
function openHistoryWithTiedConversations() {
  const records = openSqliteConversationRecords()
  const ids = [1, 2, 3].map((sequence) => {
    const id = createFixtureUuidV7(sequence)
    records.saveConversation({
      id,
      title: `Conversation ${sequence}`,
      systemPrompt: "You are Lys.",
      createdAt: "2025-01-01T00:05:00.000Z"
    })
    return id
  })
  return {
    history: new StoredConversationHistoryReader(records.recordReader),
    ids
  }
}

/**
 * Creates a history reader over records holding one invalid conversation.
 *
 * @returns The reader, the records, and the invalid conversation id.
 */
function createHistoryOverInvalidRow() {
  const records = openSqliteConversationRecords()
  const conversationId = createFixtureUuidV7(1)
  records.saveConversation({
    id: conversationId,
    title: "",
    systemPrompt: "You are Lys.",
    createdAt: "2025-01-01T00:00:00.000Z"
  })
  return {
    records,
    conversationId,
    history: new StoredConversationHistoryReader(records.recordReader)
  }
}

describe("StoredConversationHistoryReader", () => {
  describe("getConversation", () => {
    it("reads the committed conversation and transcript", () => {
      const { history, turn } = openHistoryWithTurn()

      expect(history.getConversation(turn.conversation.id)).toMatchObject({
        id: turn.conversation.id,
        messages: [turn.userMessage, turn.assistantMessage]
      })
    })

    it("returns undefined for an absent conversation", () => {
      const { history } = openHistoryWithTurn()

      expect(history.getConversation(createFixtureUuidV7(9))).toBeUndefined()
    })

    it("ends its read snapshot so later writes can begin", () => {
      const { history, turns, turn } = openHistoryWithTurn()
      history.getConversation(turn.conversation.id)

      expect(() =>
        turns.createConversationTurn({
          conversationId: turn.conversation.id,
          userMessageContent: "Again",
          model: "qwen/qwen3-8b",
          systemPrompt: "You are Lys."
        })
      ).not.toThrow()
    })

    it("rejects invalid stored data and ends its read snapshot", () => {
      const { records, conversationId, history } = createHistoryOverInvalidRow()

      expect(() => history.getConversation(conversationId)).toThrow(z.ZodError)

      expect(records.recordEditor.deleteConversation(conversationId)).toBe(true)
    })
  })

  describe("listConversations", () => {
    it("lists committed conversations as the final page", () => {
      const { history, turn } = openHistoryWithTurn()
      const stored = history.getConversation(turn.conversation.id)

      expect(history.listConversations(parseConversationListOptions())).toEqual(
        {
          conversations: [
            {
              id: turn.conversation.id,
              title: null,
              createdAt: stored?.createdAt,
              updatedAt: stored?.updatedAt,
              preview: { role: "user", content: "Plan the TRIP" }
            }
          ],
          storedCount: 1,
          matchCount: 1,
          nextCursor: null
        }
      )
    })

    it("searches with the parsed query case-insensitively", () => {
      const { history, turn } = openHistoryWithTurn()

      expect(
        history
          .listConversations(parseConversationListOptions({ query: "trip" }))
          .conversations.map(({ id }) => id)
      ).toEqual([turn.conversation.id])
      expect(
        history.listConversations(
          parseConversationListOptions({ query: "budget" })
        ).matchCount
      ).toBe(0)
    })

    it("continues after the last row of a full page until the final page", () => {
      const { history, ids } = openHistoryWithTiedConversations()

      const firstPage = history.listConversations(
        parseConversationListOptions({ limit: 2 })
      )
      expect(firstPage.conversations.map(({ id }) => id)).toEqual([
        ids[2],
        ids[1]
      ])
      expect(firstPage.nextCursor).toEqual(expect.any(String))

      const secondPage = history.listConversations(
        parseConversationListOptions({
          limit: 2,
          ...(firstPage.nextCursor === null
            ? {}
            : { cursor: firstPage.nextCursor })
        })
      )
      expect(secondPage.conversations.map(({ id }) => id)).toEqual([ids[0]])
      expect(secondPage.nextCursor).toBeNull()
      expect(secondPage.storedCount).toBe(3)
    })

    it("returns no continuation when the rows exactly fill the page", () => {
      const { history } = openHistoryWithTiedConversations()

      const page = history.listConversations(
        parseConversationListOptions({ limit: 3 })
      )

      expect(page.conversations).toHaveLength(3)
      expect(page.nextCursor).toBeNull()
    })

    it("rejects invalid stored data and ends its read snapshot", () => {
      const { records, conversationId, history } = createHistoryOverInvalidRow()

      expect(() =>
        history.listConversations(parseConversationListOptions())
      ).toThrow(z.ZodError)

      expect(records.recordEditor.deleteConversation(conversationId)).toBe(true)
    })
  })

  it("rejects every operation after the database closes", () => {
    const { database, history, turn } = openHistoryWithTurn()
    expect(history.getConversation(turn.conversation.id)).toBeDefined()
    expect(
      history.listConversations(parseConversationListOptions()).storedCount
    ).toBe(1)

    database[Symbol.dispose]()

    expect(() => history.getConversation(turn.conversation.id)).toThrow(
      "Database is closed"
    )
    expect(() =>
      history.listConversations(parseConversationListOptions())
    ).toThrow("Database is closed")
  })
})
