import { describe, expect, it } from "vitest"
import {
  buildRenumberedCitations,
  listCitedNumbers
} from "../../../../src/modules/conversation/citationNumbers"

describe("buildRenumberedCitations", () => {
  it("rewrites [1] and [2] to their new numbers and leaves [3] alone when 3 is not a key", () => {
    const numbers = new Map([
      [1, 4],
      [2, 5]
    ])

    const renumbered = buildRenumberedCitations(
      "Wool [1], silk [2], and fur [3].",
      numbers
    )

    expect(renumbered.text).toBe("Wool [4], silk [5], and fur [3].")
  })

  it("swaps [1] and [2] in one pass without rewriting a marker twice", () => {
    const numbers = new Map([
      [1, 2],
      [2, 1]
    ])

    const renumbered = buildRenumberedCitations(
      "Wool [1], silk [2], and wool again [1].",
      numbers
    )

    expect(renumbered.text).toBe("Wool [2], silk [1], and wool again [2].")
  })

  it("returns the new numbers ascending and once each, and none for a text without known markers", () => {
    const numbers = new Map([
      [1, 7],
      [2, 3],
      [3, 5]
    ])

    const renumbered = buildRenumberedCitations(
      "Silk [3], wool [1], fur [9], and silk again [3].",
      numbers
    )
    const unchanged = buildRenumberedCitations("Fur [9], no page.", numbers)

    expect(renumbered.citedNumbers).toEqual([5, 7])
    expect(unchanged).toEqual({ text: "Fur [9], no page.", citedNumbers: [] })
  })

  it("leaves [0], [01], [1, 2], and [a] untouched", () => {
    const text = "None of [0], [01], [1, 2], or [a] cites a page."
    const numbers = new Map([
      [0, 4],
      [1, 5],
      [2, 6]
    ])

    const renumbered = buildRenumberedCitations(text, numbers)

    expect(renumbered).toEqual({ text, citedNumbers: [] })
  })

  it("rewrites a marker inside a code span and a code block too", () => {
    const numbers = new Map([[1, 4]])

    const renumbered = buildRenumberedCitations(
      "Run `cite [1]`:\n```\nwool [1]\n```",
      numbers
    )

    expect(renumbered).toEqual({
      text: "Run `cite [4]`:\n```\nwool [4]\n```",
      citedNumbers: [4]
    })
  })
})

describe("listCitedNumbers", () => {
  it("lists the number of every marker ascending and once each, a marker in code included", () => {
    expect(
      listCitedNumbers("Silk [3], wool [12], `[1]`, and silk again [3].")
    ).toEqual([1, 3, 12])
  })

  it("lists none for a text whose brackets hold no marker", () => {
    expect(
      listCitedNumbers("None of [0], [01], [1, 2], or [a] cites a page.")
    ).toEqual([])
  })
})
