import type { ToolArgumentDefinitionCandidate } from "@lys/share"
import { describe, expect, it } from "vitest"
import {
  buildToolGroups,
  calculateOfferedToolTotals,
  calculateToolCallsTone,
  calculateToolTokenEstimate,
  findToolApproval,
  formatToolAccessLabel,
  formatToolApprovalLabel,
  formatToolApprovalNote,
  formatToolArgumentCounts,
  formatToolArgumentRequirement,
  formatToolArgumentType,
  formatToolCallsStatus,
  formatToolGroupCount,
  formatToolGroupLabel,
  formatToolTokenEstimate
} from "@/components/SettingsViewComponents/tool-presentation"
import { buildToolDefinition } from "../../support/toolFixtures"

/** Tools listed in Settings order. */
const READ_TEXT_FILE = buildToolDefinition("read_text_file")
const FIND_FILES = buildToolDefinition("find_files")

/**
 * Lists the arguments of a tool the shared schema accepted.
 *
 * @param candidates - Arguments as a tool declares them.
 * @returns The validated arguments.
 */
function buildArguments(
  candidates: readonly ToolArgumentDefinitionCandidate[]
) {
  return buildToolDefinition("probe", candidates).arguments
}

describe("calculateToolTokenEstimate", () => {
  it("grows with what the model is told about the tool", () => {
    const bare = buildToolDefinition("probe", [])
    const withArgument = buildToolDefinition("probe")

    expect(calculateToolTokenEstimate(bare)).toBeGreaterThan(0)
    expect(calculateToolTokenEstimate(withArgument)).toBeGreaterThan(
      calculateToolTokenEstimate(bare)
    )
  })
})

describe("calculateOfferedToolTotals", () => {
  it("counts every tool while none was switched off", () => {
    expect(
      calculateOfferedToolTotals([READ_TEXT_FILE, FIND_FILES], new Map())
    ).toEqual({
      offeredToolCount: 2,
      offeredTokenCount:
        calculateToolTokenEstimate(READ_TEXT_FILE) +
        calculateToolTokenEstimate(FIND_FILES)
    })
  })

  it("leaves out tools switched off, whatever their approval", () => {
    const choices = new Map([
      ["read_text_file", { isOn: false, approval: "ask" } as const],
      ["find_files", { isOn: true, approval: "ask" } as const]
    ])

    expect(
      calculateOfferedToolTotals([READ_TEXT_FILE, FIND_FILES], choices)
    ).toEqual({
      offeredToolCount: 1,
      offeredTokenCount: calculateToolTokenEstimate(FIND_FILES)
    })
  })
})

describe("formatToolTokenEstimate", () => {
  it("marks the count as an estimate", () => {
    expect(formatToolTokenEstimate(108)).toBe("~108 tok")
    expect(formatToolTokenEstimate(1500)).toBe("~1.5k tok")
  })
})

describe("formatToolCallsStatus", () => {
  it("says nothing is offered while tool calls are off, whatever the model", () => {
    expect(
      formatToolCallsStatus({
        areToolCallsOn: false,
        support: { status: "trained", modelKey: "trained" },
        offeredToolCount: 2,
        offeredTokenCount: 216
      })
    ).toBe("agents answer from the prompt alone · nothing is offered")
  })

  it("states the offer, after the loaded model's key when one is known", () => {
    const offer = {
      areToolCallsOn: true,
      offeredToolCount: 2,
      offeredTokenCount: 216
    }

    expect(
      formatToolCallsStatus({ ...offer, support: { status: "unknown" } })
    ).toBe("2 offered · ~216 tok per request")
    expect(
      formatToolCallsStatus({
        ...offer,
        support: { status: "trained", modelKey: "trained" }
      })
    ).toBe("trained · 2 offered · ~216 tok per request")
  })

  it("says nothing is offered to a model not trained for tool calls", () => {
    expect(
      formatToolCallsStatus({
        areToolCallsOn: true,
        support: { status: "untrained", modelKey: "untrained" },
        offeredToolCount: 2,
        offeredTokenCount: 216
      })
    ).toBe("untrained isn't trained for tool calls · nothing is offered")
  })
})

describe("calculateToolCallsTone", () => {
  it("is neutral while off, a warning for an untrained model, and active otherwise", () => {
    expect(
      calculateToolCallsTone(false, { status: "untrained", modelKey: "m" })
    ).toBe("neutral")
    expect(
      calculateToolCallsTone(true, { status: "untrained", modelKey: "m" })
    ).toBe("warning")
    expect(calculateToolCallsTone(true, { status: "unknown" })).toBe("active")
    expect(
      calculateToolCallsTone(true, { status: "trained", modelKey: "m" })
    ).toBe("active")
  })
})

describe("buildToolGroups", () => {
  it("lists each group once with its tools in list order", () => {
    const groups = buildToolGroups([READ_TEXT_FILE, FIND_FILES])

    expect(groups).toEqual([
      { group: "files", tools: [READ_TEXT_FILE, FIND_FILES] }
    ])
    expect(Object.isFrozen(groups)).toBe(true)
    expect(Object.isFrozen(groups[0].tools)).toBe(true)
  })

  it("lists no group without tools", () => {
    expect(buildToolGroups([])).toEqual([])
  })
})

describe("tool labels", () => {
  it("names the group, its count, and the access level in lowercase", () => {
    expect(formatToolGroupLabel("files")).toBe("files")
    expect(formatToolGroupCount(1, 2)).toBe("1 of 2 on")
    expect(formatToolAccessLabel("reads")).toBe("reads")
  })

  it("names each argument type, counting an enum's values", () => {
    const [text, count, whole, flag, mode] = buildArguments([
      { type: "string", name: "text", description: "Text." },
      { type: "number", name: "count", description: "Count." },
      { type: "integer", name: "whole", description: "Whole." },
      { type: "boolean", name: "flag", description: "Flag." },
      {
        type: "enum",
        name: "mode",
        description: "Mode.",
        values: ["fast", "exact", "fuzzy"]
      }
    ])

    expect(
      [text, count, whole, flag, mode].map(formatToolArgumentType)
    ).toEqual(["string", "number", "integer", "boolean", "enum · 3"])
  })

  it("says whether an argument is required", () => {
    expect(formatToolArgumentRequirement(true)).toBe("required")
    expect(formatToolArgumentRequirement(false)).toBe("optional")
  })

  it.each([
    [[], "none"],
    [
      [
        { type: "string", name: "a", description: "A." },
        { type: "string", name: "b", description: "B.", required: false }
      ],
      "1 required · 1 optional"
    ],
    [
      [
        { type: "string", name: "a", description: "A.", required: false },
        { type: "string", name: "b", description: "B.", required: false }
      ],
      "2 optional"
    ],
    [[{ type: "string", name: "a", description: "A." }], "1 required"]
  ] as const)("counts the arguments %o as %s", (candidates, label) => {
    expect(formatToolArgumentCounts(buildArguments(candidates))).toBe(label)
  })

  it("labels and explains each approval", () => {
    expect(formatToolApprovalLabel("ask")).toBe("Ask me")
    expect(formatToolApprovalLabel("run")).toBe("Just run")
    expect(formatToolApprovalNote("ask")).toBe(
      "You see the call and its arguments. Nothing happens until you say yes."
    )
    expect(formatToolApprovalNote("run")).toBe(
      "Runs the moment the model asks for it."
    )
  })
})

describe("findToolApproval", () => {
  it("finds the approval a toggle group reports, or nothing", () => {
    expect(findToolApproval(["ask"])).toBe("ask")
    expect(findToolApproval(["run"])).toBe("run")
    expect(findToolApproval([])).toBeUndefined()
    expect(findToolApproval(["later"])).toBeUndefined()
  })
})
