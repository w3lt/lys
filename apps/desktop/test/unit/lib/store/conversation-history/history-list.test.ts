import { describe, expect, it } from "vitest"
import {
  buildConversationHistoryPage,
  buildExtendedConversationHistoryPage,
  calculatePendingList,
  calculateSettledList,
  IDLE_LIST,
  removeConversationHistoryEntry,
  updateConversationHistoryEntryTitle,
  type ConversationHistoryListState,
  type ConversationHistoryPage
} from "@/lib/store/conversation-history/history-list"
import {
  buildConversationListPage,
  buildConversationSummary,
  createFixtureUuidV7
} from "../../../support/conversationFixtures"

/** Conversations of the first page, newest first. */
const FIRST_SUMMARIES = [
  buildConversationSummary(createFixtureUuidV7(3), "Third", {
    role: "user",
    content: "green tea"
  }),
  buildConversationSummary(createFixtureUuidV7(2), "Second", null)
]

/** First page of a search for `tea`, with an older page to read. */
const FIRST_PAGE: ConversationHistoryPage = buildConversationHistoryPage(
  "tea",
  buildConversationListPage(FIRST_SUMMARIES, {
    storedCount: 10,
    matchCount: 4,
    nextCursor: "older"
  })
)

/** List displaying {@link FIRST_PAGE} with no pending work. */
const LOADED_LIST: ConversationHistoryListState = Object.freeze({
  status: "loaded",
  page: FIRST_PAGE,
  activity: Object.freeze({ status: "idle" })
})

describe("buildConversationHistoryPage", () => {
  it("projects each summary for display against the page's query", () => {
    expect(FIRST_PAGE).toEqual({
      query: "tea",
      entries: [
        {
          id: createFixtureUuidV7(3),
          title: "Third",
          updatedAt: FIRST_SUMMARIES[0]?.updatedAt,
          excerpt: { speaker: "user", text: "green tea" }
        },
        {
          id: createFixtureUuidV7(2),
          title: "Second",
          updatedAt: FIRST_SUMMARIES[1]?.updatedAt,
          excerpt: null
        }
      ],
      storedCount: 10,
      matchCount: 4,
      nextCursor: "older"
    })
    expect(Object.isFrozen(FIRST_PAGE.entries)).toBe(true)
  })
})

describe("buildExtendedConversationHistoryPage", () => {
  it("appends older entries, skips ones already shown, and takes the new counts and cursor", () => {
    const older = buildConversationListPage(
      [
        FIRST_SUMMARIES[1]!,
        buildConversationSummary(createFixtureUuidV7(1), "First", null)
      ],
      { storedCount: 9, matchCount: 3, nextCursor: null }
    )

    const page = buildExtendedConversationHistoryPage(FIRST_PAGE, older)

    expect(page.entries.map((entry) => entry.id)).toEqual([
      createFixtureUuidV7(3),
      createFixtureUuidV7(2),
      createFixtureUuidV7(1)
    ])
    expect(page).toMatchObject({
      query: "tea",
      storedCount: 9,
      matchCount: 3,
      nextCursor: null
    })
    expect(FIRST_PAGE.entries).toHaveLength(2)
  })
})

describe("calculatePendingList", () => {
  it.each<ConversationHistoryListState>([
    IDLE_LIST,
    { status: "loading" },
    { status: "failed", error: "Offline" }
  ])("shows a first read while nothing is displayed ($status)", (list) => {
    expect(calculatePendingList(list)).toEqual({ status: "loading" })
  })

  it("keeps the displayed page while its replacement is read", () => {
    const olderFailed: ConversationHistoryListState = {
      ...LOADED_LIST,
      activity: { status: "older-failed", error: "Offline" }
    }

    expect(calculatePendingList(olderFailed)).toEqual({
      status: "loaded",
      page: FIRST_PAGE,
      activity: { status: "refreshing" }
    })
  })
})

describe("calculateSettledList", () => {
  it.each<ConversationHistoryListState>([
    IDLE_LIST,
    { status: "failed", error: "Offline" },
    LOADED_LIST
  ])("leaves a list without pending work as it is ($status)", (list) => {
    expect(calculateSettledList(list)).toBe(list)
  })

  it("returns an abandoned first read to idle", () => {
    expect(calculateSettledList({ status: "loading" })).toEqual(IDLE_LIST)
  })

  it.each(["refreshing", "loading-older"] as const)(
    "keeps the displayed page and drops the abandoned %s work",
    (status) => {
      expect(
        calculateSettledList({ ...LOADED_LIST, activity: { status } })
      ).toEqual(LOADED_LIST)
    }
  )
})

describe("updateConversationHistoryEntryTitle", () => {
  it("replaces the title of the displayed entry in place", () => {
    const list = updateConversationHistoryEntryTitle(
      LOADED_LIST,
      createFixtureUuidV7(2),
      "Renamed"
    )

    expect(
      list.status === "loaded" &&
        list.page.entries.map((entry) => [entry.id, entry.title])
    ).toEqual([
      [createFixtureUuidV7(3), "Third"],
      [createFixtureUuidV7(2), "Renamed"]
    ])
    expect(FIRST_PAGE.entries[1]?.title).toBe("Second")
  })

  it("returns the unchanged list when the entry is not displayed", () => {
    expect(
      updateConversationHistoryEntryTitle(
        LOADED_LIST,
        createFixtureUuidV7(99),
        "Renamed"
      )
    ).toBe(LOADED_LIST)
  })

  it("returns a list without a displayed page unchanged", () => {
    expect(
      updateConversationHistoryEntryTitle(
        IDLE_LIST,
        createFixtureUuidV7(2),
        "x"
      )
    ).toBe(IDLE_LIST)
  })
})

describe("removeConversationHistoryEntry", () => {
  it("removes the displayed entry and reduces both counts", () => {
    const list = removeConversationHistoryEntry(
      LOADED_LIST,
      createFixtureUuidV7(3)
    )

    expect(list).toEqual({
      ...LOADED_LIST,
      page: {
        ...FIRST_PAGE,
        entries: [FIRST_PAGE.entries[1]],
        storedCount: 9,
        matchCount: 3
      }
    })
  })

  it("never reduces a count below zero", () => {
    const zeroCounts: ConversationHistoryListState = {
      ...LOADED_LIST,
      page: { ...FIRST_PAGE, storedCount: 0, matchCount: 0 }
    }

    expect(
      removeConversationHistoryEntry(zeroCounts, createFixtureUuidV7(3))
    ).toMatchObject({ page: { storedCount: 0, matchCount: 0 } })
  })

  it.each<[string, ConversationHistoryListState]>([
    ["an entry that is not displayed", LOADED_LIST],
    ["a list without a displayed page", IDLE_LIST]
  ])("returns the unchanged list for %s", (_label, list) => {
    expect(removeConversationHistoryEntry(list, createFixtureUuidV7(99))).toBe(
      list
    )
  })
})
