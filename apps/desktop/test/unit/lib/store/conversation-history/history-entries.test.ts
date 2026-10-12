import { describe, expect, it } from "vitest"
import {
  buildConversationHistoryEntry,
  findTextMatch,
  parseConversationSearchQuery
} from "@/lib/store/conversation-history/history-entries"
import {
  buildConversationSummary,
  FIXTURE_CONVERSATION_ID
} from "../../../support/conversationFixtures"

/** Matches a high surrogate without its low half, or a low one without its high half. */
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/**
 * Builds the history entry for a conversation previewing one user message.
 *
 * @param content - Stored message content.
 * @param query - Parsed search query of the page.
 * @returns The entry the history panel presents.
 */
function buildUserPreviewEntry(content: string, query = "") {
  return buildConversationHistoryEntry(
    buildConversationSummary(FIXTURE_CONVERSATION_ID, "Title", {
      role: "user",
      content
    }),
    query
  )
}

describe("parseConversationSearchQuery", () => {
  it.each([
    ["  tea  ", "tea"],
    ["\tgreen tea\n", "green tea"],
    ["   ", ""]
  ])("parses %j as %j", (rawQuery, query) => {
    expect(parseConversationSearchQuery(rawQuery)).toBe(query)
  })
})

describe("findTextMatch", () => {
  it("finds the first occurrence regardless of case, with offsets in the original text", () => {
    expect(findTextMatch("Green tea or TEA", "tea")).toEqual({
      start: 6,
      end: 9
    })
  })

  it("matches beyond ASCII case folding", () => {
    expect(findTextMatch("ÉCOLE", "école")).toEqual({ start: 0, end: 5 })
  })

  it("folds case for letters outside the Basic Multilingual Plane", () => {
    expect(findTextMatch("say \u{10400}", "\u{10428}")).toEqual({
      start: 4,
      end: 6
    })
  })

  it.each([
    ["a.b", "axb a.b", { start: 4, end: 7 }],
    ["(1+1)", "is (1+1) two", { start: 3, end: 8 }],
    ["C:\\path", "open C:\\path/x", { start: 5, end: 12 }],
    ["[a]", "list [a] here", { start: 5, end: 8 }]
  ])("matches the query %j literally", (query, text, match) => {
    expect(findTextMatch(text, query)).toEqual(match)
  })

  it("finds nothing when the query is absent", () => {
    expect(findTextMatch("Green tea", "coffee")).toBeUndefined()
  })
})

describe("buildConversationHistoryEntry", () => {
  it("keeps the summary's identity, title, and activity time, frozen", () => {
    const summary = buildConversationSummary(
      FIXTURE_CONVERSATION_ID,
      null,
      null,
      "2026-03-04T05:06:07.890Z"
    )

    const entry = buildConversationHistoryEntry(summary, "")

    expect(entry).toEqual({
      id: FIXTURE_CONVERSATION_ID,
      title: null,
      updatedAt: "2026-03-04T05:06:07.890Z",
      excerpt: null
    })
    expect(Object.isFrozen(entry)).toBe(true)
  })

  it("names the speaker of the previewed message", () => {
    const entry = buildConversationHistoryEntry(
      buildConversationSummary(FIXTURE_CONVERSATION_ID, "T", {
        role: "assistant",
        content: "Sure."
      }),
      ""
    )

    expect(entry.excerpt).toEqual({ speaker: "assistant", text: "Sure." })
  })

  it("shows Markdown as one line of plain text and names code blocks", () => {
    const content = "# Plan\n\n**Step one:** run\n```sh\nrm -rf /\n```\n> done"

    expect(buildUserPreviewEntry(content).excerpt?.text).toBe(
      "Plan Step one: run code done"
    )
  })

  it("shows no excerpt when no displayable text remains", () => {
    expect(buildUserPreviewEntry("*** \n ##").excerpt).toBeNull()
  })

  it("shows a short message whole", () => {
    expect(buildUserPreviewEntry("Plan the trip").excerpt?.text).toBe(
      "Plan the trip"
    )
  })

  it("cuts a long message to a bounded opening and marks the omission", () => {
    const content = "word ".repeat(100).trim()

    const text = buildUserPreviewEntry(content).excerpt?.text ?? ""

    expect(text).toMatch(/^word word .*…$/)
    expect(content.startsWith(text.slice(0, -1))).toBe(true)
    expect(text.length).toBeLessThan(content.length)
  })

  it.each(["", "m"])(
    "does not leave half a surrogate pair where a long message is cut, after %j",
    (prefix) => {
      const content = `${prefix}${"😀".repeat(100)}`

      const text = buildUserPreviewEntry(content).excerpt?.text ?? ""

      expect(text).toMatch(/…$/)
      expect(text).not.toMatch(LONE_SURROGATE)
    }
  )

  it("shows a match near the start without a leading ellipsis", () => {
    const content = `Find the needle ${"in the hay ".repeat(20)}`

    const text = buildUserPreviewEntry(content, "needle").excerpt?.text

    expect(text).toMatch(/^Find the needle in the hay .*…$/)
  })

  it("starts the excerpt shortly before a later match and marks both omissions", () => {
    const content = `${"early words ".repeat(20)}the needle sits here ${"late words ".repeat(20)}`

    const text = buildUserPreviewEntry(content, "NEEDLE").excerpt?.text ?? ""

    expect(text).toMatch(/^….+needle sits here.*…$/)
    expect(content).toContain(text.slice(1, -1))
  })

  it("shows the end of the message after a match without a trailing ellipsis", () => {
    const content = `${"early words ".repeat(20)}the needle`

    const text = buildUserPreviewEntry(content, "needle").excerpt?.text

    expect(text).toMatch(/^….+the needle$/)
  })

  it("falls back to the opening text when the match is only in a code block", () => {
    const content = "See below\n```\nneedle()\n```"

    expect(buildUserPreviewEntry(content, "needle").excerpt?.text).toBe(
      "See below code"
    )
  })
})
