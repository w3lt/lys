import { describe, expect, it } from "vitest"
import {
  calculateRankingScores,
  listRankingWords
} from "../../../../src/utils/search/textRanking"

describe("listRankingWords", () => {
  it("lists the words of a text in order, lowercase, without punctuation or spaces", () => {
    expect(listRankingWords("Read the PAGE, then search!")).toEqual([
      "read",
      "the",
      "page",
      "then",
      "search"
    ])
  })

  it("normalizes compatibility forms before lowercasing", () => {
    expect(listRankingWords("ＷＥＢ ﬁle")).toEqual(["web", "file"])
  })

  it("finds the words of a language written without spaces", () => {
    expect(listRankingWords("天気を調べる").length).toBeGreaterThan(1)
  })

  it("lists nothing for text without words", () => {
    expect(listRankingWords(" ... !? ")).toEqual([])
  })
})

describe("calculateRankingScores", () => {
  it("gives one score per text, in text order, zero for a text without a query word", () => {
    const scores = calculateRankingScores(
      ["read a web page", "send an email", "read the time"],
      ["web"]
    )

    expect(scores).toHaveLength(3)
    expect(scores[0]).toBeGreaterThan(0)
    expect(scores[1]).toBe(0)
    expect(scores[2]).toBe(0)
  })

  it("ranks a text holding a rarer query word above one holding a common one", () => {
    const scores = calculateRankingScores(
      [
        "read a file on this machine",
        "read a web page",
        "read the clock",
        "read the calendar"
      ],
      ["read", "web"]
    )

    const [file = 0, web = 0, clock = 0, calendar = 0] = scores
    expect(web).toBeGreaterThan(file)
    expect(file).toBeGreaterThan(0)
    expect(clock).toBeGreaterThan(0)
    expect(calendar).toBeGreaterThan(0)
  })

  it("ranks a short text above a long one with the same query word once", () => {
    const [short = 0, long = 0] = calculateRankingScores(
      [
        "search the web",
        "search across many unrelated words that pad this text out further"
      ],
      ["search"]
    )

    expect(short).toBeGreaterThan(long)
  })

  it("counts a repeated query word with diminishing weight", () => {
    const [once = 0, twice = 0, thrice = 0] = calculateRankingScores(
      ["mail other words", "mail mail words", "mail mail mail"],
      ["mail"]
    )

    expect(twice).toBeGreaterThan(once)
    expect(thrice - twice).toBeLessThan(twice - once)
  })

  it("scores every text zero when no text holds a query word", () => {
    expect(calculateRankingScores(["read a page"], ["email"])).toEqual([0])
  })
})
