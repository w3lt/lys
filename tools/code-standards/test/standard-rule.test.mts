import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { citeStandardRule, githubHeadingAnchor } from "../standard-rule.mts"

describe("githubHeadingAnchor", () => {
  it("builds the anchor GitHub renders for a rule heading", () => {
    // GitHub renders this heading of FUNCTION.md with the element id
    // `user-content-func-013--complexity-limits`.
    const anchor = githubHeadingAnchor("FUNC-013 — Complexity limits")

    assert.equal(anchor, "func-013--complexity-limits")
  })
})

describe("citeStandardRule", () => {
  it("names the rule and links to its heading on the default branch", () => {
    const citation = citeStandardRule({
      ruleId: "FUNC-013",
      chapterFile: "FUNCTION.md",
      title: "Complexity limits"
    })

    assert.equal(
      citation,
      "FUNC-013: https://github.com/w3lt/lys/blob/main/docs/code_standards/FUNCTION.md#func-013--complexity-limits"
    )
  })
})
