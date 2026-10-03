import { describe, expect, it } from "vitest"
import { calculateConversationSearchMatch } from "../../../../../src/infrastructure/database/conversations/conversationSearch"

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
