import type { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import * as z from "zod"
import {
  calculateConversationSearchMatch,
  listConversations
} from "../../../../src/di/services/conversationService/listConversations"
import { parseConversationListOptions } from "../../../../src/di/services/conversationService/utils"
import {
  insertAssistantMessageRow,
  insertConversationRow,
  insertUserMessageRow,
  openConversationTestDatabase
} from "../../../support/conversationDatabase"
import { createFixtureUuidV7 } from "../../../support/conversationFixtures"

/** Values that distinguish one stored conversation in list cases. */
type ListedConversationFixture = Readonly<{
  /** Identity sequence of the conversation. */
  sequence: number
  /** Stored title. */
  title: string | null
  /** User message contents, stored one second apart after creation. */
  userMessages: readonly string[]
  /** Minute of 2025-01-01 at which the conversation was created. */
  createdAtMinute: number
}>

/**
 * Formats a fixture timestamp in the first hour of 2025-01-01.
 *
 * @param minute - Minute offset from midnight.
 * @param second - Second offset within the minute.
 * @returns An ISO timestamp with millisecond precision.
 */
function atMinute(minute: number, second = 0): string {
  return new Date(Date.UTC(2025, 0, 1, 0, minute, second)).toISOString()
}

/**
 * Stores one conversation whose activity time is its last message time.
 *
 * @param database - Migrated test database.
 * @param fixture - Conversation values.
 * @returns The stored conversation identity.
 */
function insertListedConversation(
  database: DatabaseSync,
  fixture: ListedConversationFixture
): string {
  const id = createFixtureUuidV7(fixture.sequence)
  insertConversationRow(database, {
    id,
    title: fixture.title,
    systemPrompt: "Stored prompt",
    createdAt: atMinute(fixture.createdAtMinute)
  })
  fixture.userMessages.forEach((content, index) => {
    insertUserMessageRow(database, {
      id: createFixtureUuidV7(fixture.sequence * 100 + index),
      conversationId: id,
      content,
      createdAt: atMinute(fixture.createdAtMinute, index + 1)
    })
  })
  return id
}

describe("calculateConversationSearchMatch", () => {
  it.each([
    ["an exact substring", "Plan the trip", "trip", 1],
    ["a different ASCII case", "Plan the TRIP", "trip", 1],
    ["a different non-ASCII case", "ΣΟΦΙΑ", "σοφια", 1],
    ["absent text", "Plan the trip", "budget", 0],
    ["regular-expression syntax taken literally", "abc", "a.c", 0],
    [
      "regular-expression syntax present literally",
      "cost (total)",
      "(total)",
      1
    ],
    ["SQL wildcard characters taken literally", "50 percent", "%", 0]
  ])("matches %s", (_label, content, query, expected) => {
    expect(calculateConversationSearchMatch(content, query)).toBe(expected)
  })

  it.each([
    ["a null title", null, "trip"],
    ["numeric content", 42, "4"],
    ["a non-text query", "Plan the trip", null]
  ])("never matches %s", (_label, content, query) => {
    expect(calculateConversationSearchMatch(content, query)).toBe(0)
  })
})

describe("listConversations", () => {
  it("returns an empty final page for an empty store", () => {
    const database = openConversationTestDatabase()

    expect(listConversations(database, parseConversationListOptions())).toEqual(
      { conversations: [], storedCount: 0, matchCount: 0, nextCursor: null }
    )
  })

  it("orders conversations by latest activity and then by descending identity", () => {
    const database = openConversationTestDatabase()
    const older = insertListedConversation(database, {
      sequence: 3,
      title: "Older",
      userMessages: ["a"],
      createdAtMinute: 1
    })
    const tieLow = insertListedConversation(database, {
      sequence: 1,
      title: "Tie low",
      userMessages: ["b"],
      createdAtMinute: 2
    })
    const tieHigh = insertListedConversation(database, {
      sequence: 2,
      title: "Tie high",
      userMessages: ["c"],
      createdAtMinute: 2
    })

    const page = listConversations(database, parseConversationListOptions())

    expect(page.conversations.map(({ id }) => id)).toEqual([
      tieHigh,
      tieLow,
      older
    ])
  })

  it("summarizes each conversation without its system prompt", () => {
    const database = openConversationTestDatabase()
    const id = insertListedConversation(database, {
      sequence: 1,
      title: "Trip plan",
      userMessages: ["First", "Latest"],
      createdAtMinute: 1
    })

    expect(
      listConversations(database, parseConversationListOptions()).conversations
    ).toEqual([
      {
        id,
        title: "Trip plan",
        createdAt: atMinute(1),
        updatedAt: atMinute(1, 2),
        preview: { role: "user", content: "Latest" }
      }
    ])
  })

  it("previews the latest message with content, skipping an empty reply", () => {
    const database = openConversationTestDatabase()
    const id = insertListedConversation(database, {
      sequence: 1,
      title: null,
      userMessages: ["Question"],
      createdAtMinute: 1
    })
    insertAssistantMessageRow(database, {
      id: createFixtureUuidV7(150),
      conversationId: id,
      model: "qwen/qwen3-8b",
      content: "",
      status: "streaming",
      finishReason: null,
      createdAt: atMinute(1, 30),
      updatedAt: atMinute(1, 30)
    })

    expect(
      listConversations(database, parseConversationListOptions())
        .conversations[0]?.preview
    ).toEqual({ role: "user", content: "Question" })
  })

  it("previews nothing for a conversation without messages", () => {
    const database = openConversationTestDatabase()
    insertListedConversation(database, {
      sequence: 1,
      title: null,
      userMessages: [],
      createdAtMinute: 1
    })

    expect(
      listConversations(database, parseConversationListOptions())
        .conversations[0]?.preview
    ).toBeNull()
  })

  it("lists only matching conversations and counts matches separately from stored conversations", () => {
    const database = openConversationTestDatabase()
    const titleMatch = insertListedConversation(database, {
      sequence: 1,
      title: "TRIP plan",
      userMessages: ["Unrelated"],
      createdAtMinute: 1
    })
    const messageMatch = insertListedConversation(database, {
      sequence: 2,
      title: "Budget",
      userMessages: ["Book the trip"],
      createdAtMinute: 2
    })
    insertListedConversation(database, {
      sequence: 3,
      title: "Groceries",
      userMessages: ["Milk"],
      createdAtMinute: 3
    })

    const page = listConversations(
      database,
      parseConversationListOptions({ query: "trip" })
    )

    expect(page.storedCount).toBe(3)
    expect(page.matchCount).toBe(2)
    expect(page.conversations.map(({ id }) => id)).toEqual([
      messageMatch,
      titleMatch
    ])
  })

  it("previews the latest matching message ahead of a newer non-matching message", () => {
    const database = openConversationTestDatabase()
    insertListedConversation(database, {
      sequence: 1,
      title: null,
      userMessages: ["Book the trip", "Anything else"],
      createdAtMinute: 1
    })

    expect(
      listConversations(
        database,
        parseConversationListOptions({ query: "trip" })
      ).conversations[0]?.preview
    ).toEqual({ role: "user", content: "Book the trip" })
  })

  it("previews the latest message when only the title matches", () => {
    const database = openConversationTestDatabase()
    insertListedConversation(database, {
      sequence: 1,
      title: "Trip plan",
      userMessages: ["First", "Latest"],
      createdAtMinute: 1
    })

    expect(
      listConversations(
        database,
        parseConversationListOptions({ query: "trip" })
      ).conversations[0]?.preview
    ).toEqual({ role: "user", content: "Latest" })
  })

  it("continues after the last row of a full page until the final page", () => {
    const database = openConversationTestDatabase()
    const ids = [1, 2, 3].map((sequence) =>
      insertListedConversation(database, {
        sequence,
        title: `Conversation ${sequence}`,
        userMessages: ["message"],
        createdAtMinute: 5
      })
    )

    const firstPage = listConversations(
      database,
      parseConversationListOptions({ limit: 2 })
    )
    expect(firstPage.conversations.map(({ id }) => id)).toEqual([
      ids[2],
      ids[1]
    ])
    expect(firstPage.nextCursor).toEqual(expect.any(String))

    const secondPage = listConversations(
      database,
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
    const database = openConversationTestDatabase()
    for (const sequence of [1, 2]) {
      insertListedConversation(database, {
        sequence,
        title: null,
        userMessages: ["message"],
        createdAtMinute: sequence
      })
    }

    const page = listConversations(
      database,
      parseConversationListOptions({ limit: 2 })
    )

    expect(page.conversations).toHaveLength(2)
    expect(page.nextCursor).toBeNull()
  })

  it("rejects a stored row that violates the summary contract", () => {
    const database = openConversationTestDatabase()
    insertListedConversation(database, {
      sequence: 1,
      title: "",
      userMessages: [],
      createdAtMinute: 1
    })

    expect(() =>
      listConversations(database, parseConversationListOptions())
    ).toThrow(z.ZodError)
  })
})
