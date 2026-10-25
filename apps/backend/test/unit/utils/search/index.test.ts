import { describe, expect, it } from "vitest"
import { isExactSearchMatch, hasSearchText } from "../../../../src/utils/search"

describe("hasSearchText", () => {
  it.each([
    ["an exact substring", "Plan the trip", "trip", true],
    ["a different ASCII case", "Plan the TRIP", "trip", true],
    ["a different non-ASCII case", "ΣΟΦΙΑ", "σοφια", true],
    ["the whole text", "trip", "trip", true],
    ["absent text", "Plan the trip", "budget", false],
    ["regular-expression syntax taken literally", "abc", "a.c", false],
    [
      "regular-expression syntax present literally",
      "cost (total)",
      "(total)",
      true
    ],
    ["SQL wildcard characters taken literally", "50 percent", "%", false]
  ])("matches %s", (_label, content, query, expected) => {
    expect(hasSearchText(content, query)).toBe(expected)
  })
})

describe("isExactSearchMatch", () => {
  it.each([
    ["the same text", "researcher", "researcher", true],
    ["a different case", "Researcher", "RESEARCHER", true],
    ["a different non-ASCII case", "ΣΟΦΙΑ", "σοφια", true],
    [
      "a longer text that contains the query",
      "web-researcher",
      "researcher",
      false
    ],
    ["a shorter text", "res", "researcher", false],
    ["text of the same length that differs", "abc", "a.c", false],
    ["the same astral text", "𐐀x", "𐐨X", true]
  ])("compares %s", (_label, content, query, expected) => {
    expect(isExactSearchMatch(content, query)).toBe(expected)
  })
})
