import { describe, expect, it } from "vitest"
import { listProseCitationNumbers } from "@/lib/citation-markers"

describe("listProseCitationNumbers", () => {
  it("lists each marker's number once, in first-cited order", () => {
    expect(
      listProseCitationNumbers("Moths [2] like lamps [1], as moths do [2].")
    ).toEqual([2, 1])
  })

  it("lists markers in emphasis, list items, and table cells", () => {
    expect(
      listProseCitationNumbers(
        "- Moths **fly [3]**\n- Lamps *glow [1]*\n\n| Fact |\n| --- |\n| Bark [4] |\n"
      )
    ).toEqual([3, 1, 4])
  })

  it.each([
    ["inline code", "Run `python x.py` and read `sys.argv[1]`."],
    ["a code block", "```py\nitems[2]\n```\n"],
    ["a link's text", "See [the page [1]](https://a.example/)."],
    ["a reference link", "See [1].\n\n[1]: https://model.example/\n"],
    ["inline math", "Take $x[1]$."],
    ["block math", "$$\nx[1]\n$$\n"],
    ["an image's text", "![moth [1]](https://a.example/moth.png)"],
    ["a number with a leading zero", "See [01]."],
    ["zero", "See [0]."]
  ])("lists no marker in %s, which the reply does not link", (_label, text) => {
    expect(listProseCitationNumbers(text)).toEqual([])
  })

  it("lists an escaped marker, which reads as the prose `[1]`", () => {
    expect(listProseCitationNumbers(String.raw`Escaped \[1\] marker.`)).toEqual(
      [1]
    )
  })

  it("lists a marker with no reference definition, which stays prose", () => {
    expect(listProseCitationNumbers("See [1].")).toEqual([1])
  })

  it("returns a frozen list", () => {
    expect(Object.isFrozen(listProseCitationNumbers("See [1]."))).toBe(true)
  })
})
