import { MAXIMUM_CONVERSATION_TITLE_LENGTH } from "@lys/protocol"
import { describe, expect, it } from "vitest"
import * as z from "zod"
import { parseConversationListOptions } from "../../../../src/modules/conversation/listOptions"
import { openConversationTestServices } from "../../support/conversationDatabase"
import { createFixtureUuidV7 } from "../../support/conversationFixtures"

/**
 * Opens isolated in-memory conversation adapters with one committed turn.
 *
 * @returns The test-owned database, turn access, history editor, the history
 * reader that observes its edits, and the committed turn.
 */
function openEditorWithTurn() {
  const { database, turns, editor, history } = openConversationTestServices()
  const turn = turns.createConversationTurn({
    userMessageContent: "Hello",
    model: "qwen/qwen3-8b",
    systemPrompt: "You are Lys."
  })
  return { database, turns, editor, history, turn }
}

describe("StoredConversationHistoryEditor", () => {
  describe("updateConversationTitle", () => {
    it("stores the trimmed title and returns metadata with unchanged activity time", () => {
      const { editor, history, turn } = openEditorWithTurn()
      const before = history.getConversation(turn.conversation.id)

      const metadata = editor.updateConversationTitle(
        turn.conversation.id,
        "  Greeting  "
      )

      expect(metadata).toEqual({
        id: turn.conversation.id,
        title: "Greeting",
        systemPrompt: "You are Lys.",
        createdAt: before?.createdAt,
        updatedAt: before?.updatedAt
      })
      expect(history.getConversation(turn.conversation.id)).toMatchObject({
        title: "Greeting",
        updatedAt: before?.updatedAt,
        messages: before?.messages
      })
    })

    it("accepts a title at the maximum published length", () => {
      const { editor, turn } = openEditorWithTurn()
      const title = "t".repeat(MAXIMUM_CONVERSATION_TITLE_LENGTH)

      expect(
        editor.updateConversationTitle(turn.conversation.id, title)?.title
      ).toBe(title)
    })

    it("returns undefined for an absent conversation", () => {
      const { editor } = openEditorWithTurn()

      expect(
        editor.updateConversationTitle(createFixtureUuidV7(9), "Greeting")
      ).toBeUndefined()
    })

    it.each([
      ["a blank title", "   "],
      [
        "a title longer than the published maximum",
        "t".repeat(MAXIMUM_CONVERSATION_TITLE_LENGTH + 1)
      ]
    ])("rejects %s without changing the stored title", (_label, title) => {
      const { editor, history, turn } = openEditorWithTurn()
      editor.updateConversationTitle(turn.conversation.id, "Kept")

      expect(() =>
        editor.updateConversationTitle(turn.conversation.id, title)
      ).toThrow(z.ZodError)

      expect(history.getConversation(turn.conversation.id)?.title).toBe("Kept")
    })
  })

  describe("deleteConversation", () => {
    it("removes the conversation and reports whether it existed", () => {
      const { editor, history, turn } = openEditorWithTurn()

      expect(editor.deleteConversation(turn.conversation.id)).toBe(true)
      expect(editor.deleteConversation(turn.conversation.id)).toBe(false)

      expect(history.getConversation(turn.conversation.id)).toBeUndefined()
      expect(
        history.listConversations(parseConversationListOptions()).storedCount
      ).toBe(0)
    })

    it("removes the transcript with the conversation", () => {
      const { editor, turns, turn } = openEditorWithTurn()

      editor.deleteConversation(turn.conversation.id)

      expect(
        turns.updateAssistantMessageContent(turn.assistantMessage.id, "late")
      ).toBe(false)
    })
  })

  it("rejects every operation after the database closes", () => {
    const { database, editor, turn } = openEditorWithTurn()
    expect(
      editor.updateConversationTitle(turn.conversation.id, "Title")
    ).toBeDefined()

    database[Symbol.dispose]()

    expect(() =>
      editor.updateConversationTitle(turn.conversation.id, "Title")
    ).toThrow("Database is closed")
    expect(() => editor.deleteConversation(turn.conversation.id)).toThrow(
      "Database is closed"
    )
  })
})
