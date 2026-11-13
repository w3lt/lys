import { describe, expect, it } from "vitest"
import { formatOneLine } from "../../../../src/modules/agent/oneLineText"

describe("formatOneLine", () => {
  it.each([
    ["a line feed", "Web\nResearcher", "Web Researcher"],
    [
      "a carriage return and a line feed",
      "Web\r\nResearcher",
      "Web Researcher"
    ],
    ["a tab", "Web\tResearcher", "Web Researcher"],
    ["a run of spaces", "Web   Researcher", "Web Researcher"],
    ["a line separator", "Web\u2028Researcher", "Web Researcher"],
    ["a mixed run of whitespace", "Web \n\t Researcher", "Web Researcher"]
  ])("writes %s as one space", (_label, text, line) => {
    expect(formatOneLine(text)).toBe(line)
  })

  it("replaces every whitespace run of the text", () => {
    expect(formatOneLine("Find\nthe\n\nnews of\ttoday")).toBe(
      "Find the news of today"
    )
  })

  it("leaves text on one line with single spaces unchanged", () => {
    expect(formatOneLine("Web Researcher")).toBe("Web Researcher")
  })

  it("keeps whitespace at the ends as one space each", () => {
    expect(formatOneLine("\n Web Researcher \n")).toBe(" Web Researcher ")
  })
})
