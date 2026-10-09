import { describe, expect, it } from "vitest"
import {
  buildConversationHistoryGroups,
  buildExcerptSegments,
  formatConversationHistoryCount,
  formatConversationHistoryHint,
  formatConversationTime,
  formatConversationTitle,
  shouldRequestOlderConversations
} from "@/components/ConversationHistoryComponents/conversation-history-presentation"
import {
  NO_ROW_INTERACTION,
  type ConversationHistoryListState
} from "@/lib/store/conversation-history"
import { buildConversationHistoryEntry } from "@/lib/store/conversation-history/history-entries"
import { buildConversationHistoryPage } from "@/lib/store/conversation-history/history-list"
import {
  buildConversationListPage,
  buildConversationSummary,
  createFixtureUuidV7
} from "../../support/conversationFixtures"

/**
 * Builds a local time on 9 October 2026, the day history was opened.
 *
 * @param hours - Local hour.
 * @param minutes - Local minute.
 * @param dayOffset - Days added to 9 October; negative for earlier days.
 * @returns Epoch milliseconds of that local time.
 * @remarks Local constructors keep the cases independent of the time zone
 * the suite runs in; no daylight-saving change falls in the days used.
 */
function buildLocalTimeMs(hours: number, minutes: number, dayOffset = 0) {
  return new Date(2026, 9, 9 + dayOffset, hours, minutes).getTime()
}

/** When history was opened: 9 October 2026, 14:30 local time. */
const OPENED_AT_MS = buildLocalTimeMs(14, 30)

/**
 * Builds the history entry for a conversation last active at a local time.
 *
 * @param sequence - Identity sequence.
 * @param updatedAtMs - Epoch milliseconds of its last activity.
 * @returns The entry as the history store projects it.
 */
function buildEntry(sequence: number, updatedAtMs: number) {
  return buildConversationHistoryEntry(
    buildConversationSummary(
      createFixtureUuidV7(sequence),
      `Conversation ${sequence}`,
      null,
      new Date(updatedAtMs).toISOString()
    ),
    ""
  )
}

/**
 * Builds a displayed list.
 *
 * @param query - Parsed query the page answers.
 * @param counts - Stored and matching conversation counts.
 * @returns A loaded list with one listed conversation per match, up to two.
 */
function buildLoadedList(
  query: string,
  counts: { readonly storedCount: number; readonly matchCount: number }
): ConversationHistoryListState {
  const summaries = Array.from(
    { length: Math.min(counts.matchCount, 2) },
    (_, index) =>
      buildConversationSummary(createFixtureUuidV7(index + 1), null, null)
  )
  return {
    status: "loaded",
    page: buildConversationHistoryPage(
      query,
      buildConversationListPage(summaries, counts)
    ),
    activity: { status: "idle" }
  }
}

describe("formatConversationTitle", () => {
  it("shows the stored title, or Untitled before one exists", () => {
    const entry = buildEntry(1, OPENED_AT_MS)

    expect(formatConversationTitle(entry)).toBe("Conversation 1")
    expect(formatConversationTitle({ ...entry, title: null })).toBe("Untitled")
  })
})

describe("buildConversationHistoryGroups", () => {
  it("groups entries into Today, Yesterday, and Earlier, keeping list order", () => {
    const todayLate = buildEntry(1, buildLocalTimeMs(14, 0))
    const todayEarly = buildEntry(2, buildLocalTimeMs(0, 0))
    const yesterdayLate = buildEntry(3, buildLocalTimeMs(23, 59, -1))
    const yesterdayEarly = buildEntry(4, buildLocalTimeMs(0, 1, -1))
    const twoDaysAgo = buildEntry(5, buildLocalTimeMs(23, 59, -2))

    const groups = buildConversationHistoryGroups(
      [todayLate, todayEarly, yesterdayLate, yesterdayEarly, twoDaysAgo],
      OPENED_AT_MS
    )

    expect(groups).toEqual([
      { label: "Today", entries: [todayLate, todayEarly] },
      { label: "Yesterday", entries: [yesterdayLate, yesterdayEarly] },
      { label: "Earlier", entries: [twoDaysAgo] }
    ])
  })

  it("omits empty groups", () => {
    const earlier = buildEntry(1, buildLocalTimeMs(12, 0, -30))

    expect(buildConversationHistoryGroups([earlier], OPENED_AT_MS)).toEqual([
      { label: "Earlier", entries: [earlier] }
    ])
    expect(buildConversationHistoryGroups([], OPENED_AT_MS)).toEqual([])
  })

  it("counts activity after history opened as Today", () => {
    const later = buildEntry(1, buildLocalTimeMs(10, 0, 1))

    expect(buildConversationHistoryGroups([later], OPENED_AT_MS)).toEqual([
      { label: "Today", entries: [later] }
    ])
  })

  it("returns groups that cannot be changed", () => {
    const groups = buildConversationHistoryGroups(
      [buildEntry(1, OPENED_AT_MS)],
      OPENED_AT_MS
    )

    expect(Object.isFrozen(groups)).toBe(true)
    expect(Object.isFrozen(groups[0])).toBe(true)
    expect(Object.isFrozen(groups[0].entries)).toBe(true)
  })
})

describe("formatConversationTime", () => {
  it.each([
    ["under a minute ago", buildLocalTimeMs(14, 29) + 1, "now"],
    ["after history opened", buildLocalTimeMs(14, 45), "now"],
    ["one minute ago", buildLocalTimeMs(14, 29), "1m"],
    ["59 minutes ago", buildLocalTimeMs(13, 31), "59m"],
    ["an hour ago", buildLocalTimeMs(13, 30), "13:30"],
    ["early this morning", buildLocalTimeMs(0, 5), "00:05"],
    ["yesterday", buildLocalTimeMs(9, 5, -1), "09:05"],
    ["two days ago", buildLocalTimeMs(9, 5, -2), "wed"],
    ["six days ago", buildLocalTimeMs(9, 5, -6), "sat"],
    ["a week ago", buildLocalTimeMs(9, 5, -7), "10/2"],
    ["months ago", buildLocalTimeMs(9, 5, -200), "3/23"]
  ])("shows activity %s as %s", (_case, timeMs, label) => {
    expect(
      formatConversationTime(new Date(timeMs).toISOString(), OPENED_AT_MS)
    ).toBe(label)
  })
})

describe("buildExcerptSegments", () => {
  it("highlights the first match case-insensitively, keeping the excerpt's own case", () => {
    expect(
      buildExcerptSegments("Use LM Studio, then lm studio again", "lm studio")
    ).toEqual({
      before: "Use ",
      match: "LM Studio",
      after: ", then lm studio again"
    })
  })

  it("marks nothing while not searching or when nothing matches", () => {
    const unmarked = { before: "Hello there", match: "", after: "" }

    expect(buildExcerptSegments("Hello there", "")).toEqual(unmarked)
    expect(buildExcerptSegments("Hello there", "bye")).toEqual(unmarked)
  })

  it("matches the query literally, not as a pattern", () => {
    expect(buildExcerptSegments("costs $5 (approx.)", "(approx.)")).toEqual({
      before: "costs $5 ",
      match: "(approx.)",
      after: ""
    })
  })
})

describe("shouldRequestOlderConversations", () => {
  const listed = buildLoadedList("", { storedCount: 2, matchCount: 2 })
  const olderFailed: ConversationHistoryListState =
    listed.status === "loaded"
      ? {
          ...listed,
          activity: { status: "older-failed", error: "Could not read." }
        }
      : listed

  it("requests older entries on every scroll near the end", () => {
    expect(shouldRequestOlderConversations(true, false, listed)).toBe(true)
    expect(shouldRequestOlderConversations(true, true, listed)).toBe(true)
  })

  it("requests nothing away from the end", () => {
    expect(shouldRequestOlderConversations(false, true, listed)).toBe(false)
    expect(shouldRequestOlderConversations(false, false, olderFailed)).toBe(
      false
    )
  })

  it("after an older page failed, retries only on arriving near the end again", () => {
    expect(shouldRequestOlderConversations(true, true, olderFailed)).toBe(false)
    expect(shouldRequestOlderConversations(true, false, olderFailed)).toBe(true)
  })
})

describe("formatConversationHistoryCount", () => {
  it("shows nothing before a page is displayed", () => {
    expect(formatConversationHistoryCount({ status: "loading" })).toBe("")
    expect(
      formatConversationHistoryCount({ status: "failed", error: "Offline." })
    ).toBe("")
  })

  it("shows the stored count, matches out of stored while searching, and an empty history", () => {
    expect(
      formatConversationHistoryCount(
        buildLoadedList("", { storedCount: 12, matchCount: 12 })
      )
    ).toBe("12 kept")
    expect(
      formatConversationHistoryCount(
        buildLoadedList("lys", { storedCount: 12, matchCount: 3 })
      )
    ).toBe("3 of 12")
    expect(
      formatConversationHistoryCount(
        buildLoadedList("", { storedCount: 0, matchCount: 0 })
      )
    ).toBe("nothing kept")
  })
})

describe("formatConversationHistoryHint", () => {
  const listed = buildLoadedList("", { storedCount: 2, matchCount: 2 })

  it("explains renaming with the title limit while a title is edited", () => {
    expect(
      formatConversationHistoryHint(
        listed,
        {
          kind: "editing-title",
          conversationId: createFixtureUuidV7(1),
          draftTitle: "Draft"
        },
        200
      )
    ).toBe("Enter saves · ESC cancels · Up to 200 characters")
  })

  it("warns that deleting cannot be undone while a deletion is confirmed", () => {
    expect(
      formatConversationHistoryHint(
        listed,
        { kind: "confirming-delete", conversationId: createFixtureUuidV7(1) },
        200
      )
    ).toBe("Deleting cannot be undone · ESC keeps it")
  })

  it("explains browsing keys, or that sends are kept while nothing is stored", () => {
    expect(formatConversationHistoryHint(listed, NO_ROW_INTERACTION, 200)).toBe(
      "Arrows move · Enter continues · F2 renames"
    )
    expect(
      formatConversationHistoryHint(
        { status: "loading" },
        NO_ROW_INTERACTION,
        200
      )
    ).toBe("Arrows move · Enter continues · F2 renames")
    expect(
      formatConversationHistoryHint(
        buildLoadedList("", { storedCount: 0, matchCount: 0 }),
        NO_ROW_INTERACTION,
        200
      )
    ).toBe("Anything you send is kept here")
  })
})
