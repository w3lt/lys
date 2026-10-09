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
    const content = "m".repeat(58)

    expect(buildUserPreviewEntry(content).excerpt?.text).toBe(content)
  })

  it("cuts a long message after 58 characters and marks the omission", () => {
    expect(buildUserPreviewEntry("m".repeat(59)).excerpt?.text).toBe(
      `${"m".repeat(58)}…`
    )
  })

  it("does not leave half a surrogate pair where a long message is cut", () => {
    const content = `${"m".repeat(57)}😀 tail`

    expect(buildUserPreviewEntry(content).excerpt?.text).toBe(
      `${"m".repeat(57)}…`
    )
  })

  it("shows a match near the start without a leading ellipsis", () => {
    const content = `Find the needle ${"x".repeat(80)}`

    expect(buildUserPreviewEntry(content, "needle").excerpt?.text).toBe(
      `${content.slice(0, 68)}…`
    )
  })

  it("centres the excerpt shortly before a later match and marks both omissions", () => {
    const content = `${"a".repeat(100)} needle ${"b".repeat(100)}`

    const text = buildUserPreviewEntry(content, "NEEDLE").excerpt?.text

    expect(text).toBe(`…${content.slice(81, 149)}…`)
    expect(text?.indexOf("needle")).toBe(21)
  })

  it("shows the end of the message after a match without a trailing ellipsis", () => {
    const content = `${"a".repeat(100)} needle`

    expect(buildUserPreviewEntry(content, "needle").excerpt?.text).toBe(
      `…${content.slice(81)}`
    )
  })

  it("falls back to the opening text when the match is only in a code block", () => {
    const content = "See below\n```\nneedle()\n```"

    expect(buildUserPreviewEntry(content, "needle").excerpt?.text).toBe(
      "See below code"
    )
  })
})
