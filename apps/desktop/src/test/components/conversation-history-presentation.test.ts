import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import {
  buildConversationHistoryGroups,
  buildExcerptSegments,
  formatConversationHistoryCount,
  formatConversationTime,
  formatConversationTitle
} from "@/components/ConversationHistoryComponents/conversation-history-presentation"
import {
  type ConversationHistoryEntry,
  type ConversationHistoryListState
} from "@/lib/store/conversation-history"
import { buildConversationHistoryEntry } from "@/lib/store/conversation-history/history-entries"

import {
  buildConversationSummary,
  FIXTURE_IDS
} from "../fixtures/conversations"

/** Reference time: Friday 2026-09-11 12:00 in the pinned UTC zone. */
const REFERENCE_TIME_MS = Date.parse("2026-09-11T12:00:00.000Z")

/**
 * Builds an entry with only the fields grouping and time labels read.
 *
 * @param id - Entry identity.
 * @param updatedAt - ISO activity time under test.
 * @returns A frozen entry without title or excerpt.
 */
function buildEntry(id: string, updatedAt: string): ConversationHistoryEntry {
  return Object.freeze({ id, title: null, updatedAt, excerpt: null })
}

/**
 * Builds a loaded list whose page has the given query and counts.
 *
 * @param query - Parsed query of the page.
 * @param storedCount - Stored conversations.
 * @param matchCount - Matching conversations.
 * @returns A settled loaded list with no entries.
 */
function buildLoadedList(
  query: string,
  storedCount: number,
  matchCount: number
): ConversationHistoryListState {
  return {
    status: "loaded",
    page: { query, entries: [], storedCount, matchCount, nextCursor: null },
    activity: { status: "idle" }
  }
}

beforeAll(() => {
  vi.stubEnv("TZ", "UTC")
})

afterAll(() => {
  vi.unstubAllEnvs()
})

describe("buildConversationHistoryGroups", () => {
  it("groups entries by local calendar day in Today, Yesterday, Earlier order", () => {
    const entries = [
      buildEntry(FIXTURE_IDS.firstConversation, "2026-09-11T00:00:00.000Z"),
      buildEntry(FIXTURE_IDS.secondConversation, "2026-09-10T23:59:59.999Z"),
      buildEntry(FIXTURE_IDS.thirdConversation, "2026-09-09T12:00:00.000Z")
    ]

    const groups = buildConversationHistoryGroups(entries, REFERENCE_TIME_MS)

    expect(
      groups.map((group) => [
        group.label,
        group.entries.map((entry) => entry.id)
      ])
    ).toEqual([
      ["Today", [FIXTURE_IDS.firstConversation]],
      ["Yesterday", [FIXTURE_IDS.secondConversation]],
      ["Earlier", [FIXTURE_IDS.thirdConversation]]
    ])
  })

  it("keeps one group per day even when entries arrive out of order", () => {
    const entries = [
      buildEntry(FIXTURE_IDS.firstConversation, "2026-09-11T08:00:00.000Z"),
      buildEntry(FIXTURE_IDS.secondConversation, "2026-09-01T08:00:00.000Z"),
      buildEntry(FIXTURE_IDS.thirdConversation, "2026-09-11T09:00:00.000Z")
    ]

    const groups = buildConversationHistoryGroups(entries, REFERENCE_TIME_MS)

    expect(groups.map((group) => group.label)).toEqual(["Today", "Earlier"])
    expect(groups[0].entries.map((entry) => entry.id)).toEqual([
      FIXTURE_IDS.firstConversation,
      FIXTURE_IDS.thirdConversation
    ])
  })

  it("returns no groups for no entries", () => {
    expect(buildConversationHistoryGroups([], REFERENCE_TIME_MS)).toEqual([])
  })
})

describe("formatConversationTime", () => {
  it.each([
    ["under a minute ago", "2026-09-11T11:59:30.000Z", "now"],
    ["later than the reference", "2026-09-11T12:05:00.000Z", "now"],
    ["minutes ago today", "2026-09-11T11:49:00.000Z", "11m"],
    ["hours ago today", "2026-09-11T09:07:00.000Z", "09:07"],
    ["yesterday", "2026-09-10T21:30:00.000Z", "21:30"],
    ["within the week", "2026-09-07T08:00:00.000Z", "mon"],
    ["a week or more ago", "2026-09-04T08:00:00.000Z", "9/4"]
  ])("formats activity %s", (_label, updatedAt, expected) => {
    expect(formatConversationTime(updatedAt, REFERENCE_TIME_MS)).toBe(expected)
  })
})

describe("formatConversationTitle", () => {
  it("names an untitled conversation", () => {
    expect(
      formatConversationTitle(buildEntry(FIXTURE_IDS.firstConversation, "x"))
    ).toBe("Untitled")
  })
})

describe("buildExcerptSegments", () => {
  it("splits around the first case-insensitive match", () => {
    expect(
      buildExcerptSegments("Stop cuts the STREAM, the stream", "stream")
    ).toEqual({
      before: "Stop cuts the ",
      match: "STREAM",
      after: ", the stream"
    })
  })

  it("matches the query literally rather than as a pattern", () => {
    expect(buildExcerptSegments("costs $5 (maybe)", "$5 (")).toEqual({
      before: "costs ",
      match: "$5 (",
      after: "maybe)"
    })
  })

  it.each(["", "absent"])("marks nothing for the query %j", (query) => {
    expect(buildExcerptSegments("plain text", query)).toEqual({
      before: "plain text",
      match: "",
      after: ""
    })
  })
})

describe("formatConversationHistoryCount", () => {
  it.each<[string, ConversationHistoryListState, string]>([
    ["before a page loads", { status: "loading" }, ""],
    ["with nothing stored", buildLoadedList("", 0, 0), "nothing kept"],
    ["without a search", buildLoadedList("", 6, 6), "6 kept"],
    ["while searching", buildLoadedList("stop", 6, 3), "3 of 6"]
  ])("formats the count %s", (_label, list, expected) => {
    expect(formatConversationHistoryCount(list)).toBe(expected)
  })
})

describe("buildConversationHistoryEntry", () => {
  /**
   * Builds the entry for one previewed message and query.
   *
   * @param role - Author of the previewed message.
   * @param content - Complete stored content.
   * @param query - Parsed page query.
   * @returns The projected entry.
   */
  function buildPreviewedEntry(
    role: "user" | "assistant",
    content: string,
    query: string
  ): ConversationHistoryEntry {
    return buildConversationHistoryEntry(
      buildConversationSummary({
        id: FIXTURE_IDS.firstConversation,
        title: "Title",
        updatedAt: "2026-09-11T11:00:00.000Z",
        preview: { role, content }
      }),
      query
    )
  }

  it("removes formatting, names code blocks, and collapses whitespace", () => {
    const entry = buildPreviewedEntry(
      "assistant",
      "# Plan\n\n**Three** parts:\n```ts\nconst x = 1\n```\n> done",
      ""
    )

    expect(entry.excerpt).toEqual({
      speaker: "assistant",
      text: "Plan Three parts: code done"
    })
  })

  it("keeps the opening of long text and marks the omission", () => {
    const entry = buildPreviewedEntry("user", "a".repeat(80), "")

    expect(entry.excerpt).toEqual({
      speaker: "user",
      text: `${"a".repeat(58)}…`
    })
  })

  it("centres a long text on the first match and marks both omissions", () => {
    const content = `${"x".repeat(40)} needle ${"y".repeat(80)}`

    const entry = buildPreviewedEntry("assistant", content, "NEEDLE")

    // The match starts at 41, so the 68-unit window starts at 21: 19 x's, a
    // space, the 6-letter match, a space, and 41 y's.
    expect(entry.excerpt?.text).toBe(
      `…${"x".repeat(19)} needle ${"y".repeat(41)}…`
    )
  })

  it("never ends an excerpt on half of a surrogate pair", () => {
    const content = `${"a".repeat(57)}😀tail`

    const entry = buildPreviewedEntry("user", content, "")

    expect(entry.excerpt?.text).toBe(`${"a".repeat(57)}…`)
  })

  it("has no excerpt when the preview is absent or formatting only", () => {
    const withoutPreview = buildConversationHistoryEntry(
      buildConversationSummary({
        id: FIXTURE_IDS.firstConversation,
        title: null,
        updatedAt: "2026-09-11T11:00:00.000Z",
        preview: null
      }),
      ""
    )

    expect(withoutPreview.excerpt).toBeNull()
    expect(buildPreviewedEntry("user", "**", "").excerpt).toBeNull()
  })
})
