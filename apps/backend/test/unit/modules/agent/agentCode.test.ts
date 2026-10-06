import { agentCodeSchema } from "@lys/share"
import { describe, expect, it } from "vitest"
import { calculateAgentCode } from "../../../../src/modules/agent/agentCode"

describe("calculateAgentCode", () => {
  it.each([
    ["a single word", "Lys", 1, "lys"],
    ["words separated by a space", "Web Researcher", 1, "web-researcher"],
    ["a later attempt", "Reviewer", 3, "reviewer-3"],
    ["accented letters", "Trợ lý", 1, "tro-ly"],
    ["accents inside words", "Résumé", 1, "resume"],
    ["only accented letters", "Éé", 1, "ee"],
    ["mathematical letters", "𝐖𝐞𝐛 𝐑𝐞𝐬𝐞𝐚𝐫𝐜𝐡𝐞𝐫", 1, "web-researcher"],
    ["a capital letter without a lowercase form", "ℍ", 1, "h"],
    ["a letter without an ASCII form", "Đọc", 1, "oc"],
    ["runs of symbols", "C++ / Rust!!", 1, "c-rust"],
    ["compatibility characters", "ﬁx ½", 1, "fix-1-2"],
    ["no ASCII letter or digit", "日本語", 1, "agent"],
    ["no ASCII letter or digit on a later attempt", "🙂", 2, "agent-2"]
  ])("derives a slug from %s", (_label, name, attempt, code) => {
    expect(calculateAgentCode(name, attempt)).toBe(code)
    expect(agentCodeSchema.parse(code)).toBe(code)
  })

  it("keeps a slug of the maximum length on the first attempt", () => {
    expect(calculateAgentCode("a".repeat(64), 1)).toBe("a".repeat(64))
  })

  it("cuts a slug that decomposition makes longer than the maximum on the first attempt", () => {
    const code = calculateAgentCode("½".repeat(64), 1)

    expect(code).toBe(`${"1-2".repeat(21)}1`)
    expect(agentCodeSchema.parse(code)).toBe(code)
  })

  it("can give the same code on the first and second attempts", () => {
    const name = `${"a".repeat(62)} 2`

    expect(calculateAgentCode(name, 1)).toBe(`${"a".repeat(62)}-2`)
    expect(calculateAgentCode(name, 2)).toBe(`${"a".repeat(62)}-2`)
    expect(calculateAgentCode(name, 3)).toBe(`${"a".repeat(62)}-3`)
  })

  it.each([
    [2, `${"a".repeat(62)}-2`],
    [10, `${"a".repeat(61)}-10`]
  ])(
    "cuts a long slug so attempt %i still fits the maximum length",
    (attempt, code) => {
      expect(calculateAgentCode("a".repeat(64), attempt)).toBe(code)
      expect(agentCodeSchema.parse(code)).toBe(code)
    }
  )

  it("drops a hyphen left at the end of a cut slug", () => {
    const code = calculateAgentCode(`${"a".repeat(61)} bc`, 2)

    expect(code).toBe(`${"a".repeat(61)}-2`)
    expect(agentCodeSchema.parse(code)).toBe(code)
  })
})
