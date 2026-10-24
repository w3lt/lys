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
  formatToolCallsStatus,
  formatToolGroupCount,
  formatToolSettingsSaveStatus,
  formatToolTokenEstimate,
  formatToolUnavailableNote,
  getToolRunnerPresentation,
  isFixedInSecretsPane,
  listToolArguments
} from "@/components/SettingsViewComponents/tool-presentation"
import {
  buildBackendToolDefinition,
  buildMcpToolDefinition,
  buildToolDefinition
} from "../../support/toolFixtures"

/** Tools listed in Settings order. */
const READ_TEXT_FILE = buildToolDefinition("read_text_file")
const FIND_FILES = buildToolDefinition("find_files")

/** Backend tool that can lack what it needs to run. */
const WEB_SEARCH = buildBackendToolDefinition("web_search")

/** Tools of two MCP servers, listed after Lys's own. */
const NOTES_SEARCH = buildMcpToolDefinition("notes", "search")
const NOTES_READ = buildMcpToolDefinition("notes", "read")
const FILES_FIND = buildMcpToolDefinition("files", "find")

/**
 * Lists the arguments of a tool the shared schema accepted, as Settings
 * shows them.
 *
 * @param candidates - Arguments as a tool declares them.
 * @returns The listed arguments.
 */
function buildArguments(
  candidates: readonly ToolArgumentDefinitionCandidate[]
) {
  return listToolArguments(buildToolDefinition("probe", candidates))
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
      calculateOfferedToolTotals(
        [READ_TEXT_FILE, FIND_FILES],
        new Map(),
        new Map()
      )
    ).toEqual({
      offeredToolCount: 2,
      offeredTokenCount:
        calculateToolTokenEstimate(READ_TEXT_FILE) +
        calculateToolTokenEstimate(FIND_FILES)
    })
  })

  it("leaves out tools switched off", () => {
    const toolSwitches = new Map([
      ["read_text_file", false],
      ["find_files", true]
    ])

    expect(
      calculateOfferedToolTotals(
        [READ_TEXT_FILE, FIND_FILES],
        toolSwitches,
        new Map()
      )
    ).toEqual({
      offeredToolCount: 1,
      offeredTokenCount: calculateToolTokenEstimate(FIND_FILES)
    })
  })

  it("leaves out a switched-on tool that cannot run now", () => {
    expect(
      calculateOfferedToolTotals(
        [FIND_FILES, WEB_SEARCH],
        new Map([["web_search", true]]),
        new Map([["web_search", "api-key-missing"]])
      )
    ).toEqual({
      offeredToolCount: 1,
      offeredTokenCount: calculateToolTokenEstimate(FIND_FILES)
    })
  })
})

describe("formatToolUnavailableNote", () => {
  it.each([
    [
      "api-key-missing",
      "Needs a Tavily API key. Add one in Settings → Secrets."
    ],
    [
      "api-key-invalid",
      "The Tavily API key in settings.json isn't valid. Fix or remove secrets.tavilyApiKey in that file."
    ],
    [
      "settings-unreadable",
      "Lys couldn't read settings.json. Fix that file by hand."
    ],
    [
      "page-reader-not-ready",
      "vmo, Lys's page reader, isn't ready. See Settings → Runtime."
    ]
  ] as const)("says what to do when the reason is %s", (reason, note) => {
    expect(formatToolUnavailableNote(reason)).toBe(note)
  })
})

describe("isFixedInSecretsPane", () => {
  it("is true only for a missing key, which a save from the pane fixes", () => {
    expect(isFixedInSecretsPane("api-key-missing")).toBe(true)
    expect(isFixedInSecretsPane("api-key-invalid")).toBe(false)
    expect(isFixedInSecretsPane("settings-unreadable")).toBe(false)
    expect(isFixedInSecretsPane("page-reader-not-ready")).toBe(false)
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
      { key: "files", heading: "files", tools: [READ_TEXT_FILE, FIND_FILES] }
    ])
    expect(Object.isFrozen(groups)).toBe(true)
    expect(Object.isFrozen(groups[0].tools)).toBe(true)
  })

  it("heads each group of Lys's tools with its lowercase label", () => {
    const groups = buildToolGroups([WEB_SEARCH, READ_TEXT_FILE])

    expect(groups.map((listing) => listing.heading)).toEqual(["web", "files"])
  })

  it("lists the tools of each MCP server under the server, after Lys's own", () => {
    const groups = buildToolGroups([
      READ_TEXT_FILE,
      NOTES_SEARCH,
      FILES_FIND,
      NOTES_READ
    ])

    expect(groups).toEqual([
      { key: "files", heading: "files", tools: [READ_TEXT_FILE] },
      {
        key: "mcp:notes",
        heading: "MCP · notes",
        tools: [NOTES_SEARCH, NOTES_READ]
      },
      { key: "mcp:files", heading: "MCP · files", tools: [FILES_FIND] }
    ])
  })

  it("lists no group without tools", () => {
    expect(buildToolGroups([])).toEqual([])
  })
})

describe("tool labels", () => {
  it("names the group's count and the access level in lowercase", () => {
    expect(formatToolGroupCount(1, 2)).toBe("1 of 2 on")
    expect(formatToolAccessLabel("reads")).toBe("reads")
    expect(formatToolAccessLabel("network")).toBe("network")
    expect(formatToolAccessLabel("unknown")).toBe("depends on server")
  })

  it("says an MCP tool runs on its MCP server", () => {
    expect(getToolRunnerPresentation("mcp")).toEqual({
      label: "on MCP server",
      title: "Runs on an MCP server",
      heading: "Runs on an MCP server",
      note: "Lys’s backend sends each call to the tool’s MCP server, which does the work. Works while the backend runs and the server is connected."
    })
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
      [text, count, whole, flag, mode].map((argument) => argument.type)
    ).toEqual(["string", "number", "integer", "boolean", "enum · 3"])
    expect(mode).toEqual({
      name: "mode",
      type: "enum · 3",
      isRequired: true,
      description: "Mode.",
      values: ["fast", "exact", "fuzzy"]
    })
    expect(text.values).toBeUndefined()
  })

  it("lists an MCP tool's arguments from its input schema, in order", () => {
    const toolArguments = listToolArguments(NOTES_SEARCH)

    expect(toolArguments).toEqual([
      {
        name: "query",
        type: "string",
        isRequired: true,
        description: "Text to look for.",
        values: undefined
      },
      {
        name: "limit",
        type: "integer",
        isRequired: false,
        description: undefined,
        values: undefined
      }
    ])
    expect(Object.isFrozen(toolArguments)).toBe(true)
    expect(formatToolArgumentCounts(toolArguments)).toBe(
      "1 required · 1 optional"
    )
  })

  it("shows JSON for an MCP argument whose schema names no single type", () => {
    const tool = buildMcpToolDefinition("notes", "tag", {
      type: "object",
      properties: {
        tags: { type: ["string", "array"], description: 3 },
        mode: { enum: ["a", "b"] },
        raw: true
      }
    })

    expect(listToolArguments(tool)).toEqual([
      {
        name: "tags",
        type: "JSON",
        isRequired: false,
        description: undefined,
        values: undefined
      },
      {
        name: "mode",
        type: "JSON",
        isRequired: false,
        description: undefined,
        values: undefined
      },
      {
        name: "raw",
        type: "JSON",
        isRequired: false,
        description: undefined,
        values: undefined
      }
    ])
  })

  it("lists no argument for an MCP tool whose schema has no properties", () => {
    const tool = buildMcpToolDefinition("notes", "ping", { type: "object" })

    expect(listToolArguments(tool)).toEqual([])
    expect(formatToolArgumentCounts(listToolArguments(tool))).toBe("none")
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

  it("labels each approval", () => {
    expect(formatToolApprovalLabel("ask")).toBe("Ask me")
    expect(formatToolApprovalLabel("run")).toBe("Just run")
  })

  it.each([
    [
      "ask",
      "reads",
      "Each call waits for you with its arguments. Nothing runs until you allow it."
    ],
    [
      "ask",
      "network",
      "Each call waits for you with its arguments. Nothing runs until you allow it."
    ],
    [
      "run",
      "reads",
      "Runs the moment the model asks, without showing you the call."
    ],
    [
      "run",
      "network",
      "Sends its request off this machine the moment the model asks, without showing you what it sends."
    ],
    [
      "run",
      "unknown",
      "Runs on its MCP server the moment the model asks, without showing you what it sends. What it does depends on the MCP server."
    ]
  ] as const)(
    "explains %s for a tool with %s access",
    (approval, access, note) => {
      expect(formatToolApprovalNote(approval, access)).toBe(note)
    }
  )
})

describe("formatToolSettingsSaveStatus", () => {
  it.each([
    ["idle", ""],
    ["saving", "Saving tool choices…"],
    ["saved", ""],
    [
      "failed",
      "Couldn't save your tool choices. Each switch applies until Lys quits, but Just run keeps following the choices Lys last saved until a save works."
    ]
  ] as const)("announces a %s save as %j", (status, message) => {
    expect(formatToolSettingsSaveStatus({ status })).toBe(message)
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
