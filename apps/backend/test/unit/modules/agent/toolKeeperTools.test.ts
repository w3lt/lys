import { describe, expect, it, vi } from "vitest"
import ToolCatalog, {
  MAXIMUM_LISTED_TOOL_COUNT,
  MAXIMUM_RECOMMENDED_TOOL_COUNT
} from "../../../../src/modules/agent/toolCatalog"
import {
  buildToolKeeperTools,
  RECOMMEND_TOOL_TOOL_NAME,
  SEARCH_TOOLS_TOOL_NAME
} from "../../../../src/modules/agent/toolKeeperTools"
import type {
  BuiltInToolCallArguments,
  BuiltInToolResult,
  TurnBuiltInTool
} from "../../../../src/modules/tool/builtIn/builtInTool"
import {
  registerBuiltInToolContractSuite,
  type BuiltInToolHarness
} from "../../support/builtInToolContract"
import {
  buildNetworkToolDefinition,
  buildNoteTools
} from "../../support/toolFixtures"

/** Tools of the asking turn in most cases, in offer order. */
const TOOLS = Object.freeze([
  buildNetworkToolDefinition(
    "read_page",
    "Reads one web page and returns its text."
  ),
  buildNetworkToolDefinition(
    "send_email",
    "Sends an email message to a recipient."
  )
])

/**
 * Gets one of the tool keeper's tools by name.
 *
 * @param catalog - Catalog of the search.
 * @param name - Name of the tool.
 * @returns The tool.
 * @throws If no tool has the name.
 */
function getKeeperTool(catalog: ToolCatalog, name: string): TurnBuiltInTool {
  const tool = buildToolKeeperTools(catalog).find(
    (entry) => entry.definition.name === name
  )
  if (tool === undefined) throw new Error(`No tool keeper tool ${name}`)
  return tool
}

/**
 * Runs one call of one of the tool keeper's tools.
 *
 * @param catalog - Catalog of the search.
 * @param name - Name of the tool.
 * @param callArguments - Arguments of the call.
 * @returns The run's result.
 * @throws If the arguments do not parse.
 */
async function runKeeperTool(
  catalog: ToolCatalog,
  name: string,
  callArguments: BuiltInToolCallArguments
): Promise<BuiltInToolResult> {
  const parsed = getKeeperTool(catalog, name).tool.parseToolCall(callArguments)
  if (parsed.status !== "parsed") throw new Error(parsed.message)
  return await parsed.runToolCall({
    abortSignal: new AbortController().signal,
    addWebSources: () => []
  })
}

/**
 * Parses one call of one of the tool keeper's tools.
 *
 * @param catalog - Catalog of the search.
 * @param name - Name of the tool.
 * @param callArguments - Arguments of the call.
 * @returns The parse outcome.
 */
function parseKeeperToolCall(
  catalog: ToolCatalog,
  name: string,
  callArguments: BuiltInToolCallArguments
) {
  return getKeeperTool(catalog, name).tool.parseToolCall(callArguments)
}

/**
 * Creates `search_tools` over a catalog whose searches are counted.
 *
 * @returns The contract harness.
 */
async function createSearchToolsHarness(): Promise<BuiltInToolHarness> {
  const catalog = new ToolCatalog(TOOLS)
  const listToolMatches = vi.spyOn(catalog, "listToolMatches")
  return {
    tool: getKeeperTool(catalog, SEARCH_TOOLS_TOOL_NAME).tool,
    runnableArguments: { query: "web page" },
    invalidArguments: { query: "   " },
    countStartedWork: () => listToolMatches.mock.calls.length
  }
}

/**
 * Creates `recommend_tool` over a catalog whose recommendations are counted.
 *
 * @returns The contract harness.
 */
async function createRecommendToolHarness(): Promise<BuiltInToolHarness> {
  const catalog = new ToolCatalog(TOOLS)
  const addRecommendedTool = vi.spyOn(catalog, "addRecommendedTool")
  return {
    tool: getKeeperTool(catalog, RECOMMEND_TOOL_TOOL_NAME).tool,
    runnableArguments: { name: "read_page" },
    invalidArguments: { name: "read_file" },
    countStartedWork: () => addRecommendedTool.mock.calls.length
  }
}

describe("buildToolKeeperTools", () => {
  it("builds search_tools, then recommend_tool, each reading this machine in the backend without approval", () => {
    const tools = buildToolKeeperTools(new ToolCatalog(TOOLS))

    expect(tools.map((tool) => tool.definition.name)).toEqual([
      SEARCH_TOOLS_TOOL_NAME,
      RECOMMEND_TOOL_TOOL_NAME
    ])
    for (const tool of tools) {
      expect(tool.runsWithoutApproval).toBe(true)
      expect(tool.definition).toMatchObject({
        group: "agents",
        access: "reads",
        runner: "backend"
      })
    }
    expect(Object.isFrozen(tools)).toBe(true)
  })

  describe("search_tools", () => {
    registerBuiltInToolContractSuite(createSearchToolsHarness)

    it("lists the matching tools with their names and descriptions", async () => {
      const result = await runKeeperTool(
        new ToolCatalog(TOOLS),
        SEARCH_TOOLS_TOOL_NAME,
        { query: "  web page " }
      )

      expect(result).toEqual({
        status: "succeeded",
        content:
          'Tools that match "web page", best first:\n- read_page: Reads one web page and returns its text.',
        sources: []
      })
    })

    it.each([
      ["1 more tool", 1, "1 more tool matches"],
      ["3 more tools", 3, "3 more tools match"]
    ])(
      "says that %s match than it lists",
      async (_label, moreCount, sentenceStart) => {
        const tools = buildNoteTools(MAXIMUM_LISTED_TOOL_COUNT + moreCount)

        const result = await runKeeperTool(
          new ToolCatalog(tools),
          SEARCH_TOOLS_TOOL_NAME,
          { query: "note" }
        )

        const lines = result.content.split("\n")
        expect(lines).toHaveLength(MAXIMUM_LISTED_TOOL_COUNT + 2)
        expect(lines.at(-1)).toBe(
          `${sentenceStart}; search with other words to narrow the list.`
        )
      }
    )

    it("lists every match without a count of more when all of them fit", async () => {
      const tools = buildNoteTools(MAXIMUM_LISTED_TOOL_COUNT)

      const result = await runKeeperTool(
        new ToolCatalog(tools),
        SEARCH_TOOLS_TOOL_NAME,
        { query: "note" }
      )

      expect(result.content.split("\n")).toEqual([
        'Tools that match "note", best first:',
        ...tools.map((tool) => `- ${tool.name}: Keeps a note.`)
      ])
    })

    it("shows a description on one line, each run of whitespace as one space", async () => {
      const result = await runKeeperTool(
        new ToolCatalog([
          buildNetworkToolDefinition("keep_note", "  Keeps\na \t note.\r\n")
        ]),
        SEARCH_TOOLS_TOOL_NAME,
        { query: "note" }
      )

      expect(result.content.split("\n")[1]).toBe("- keep_note: Keeps a note.")
    })

    it.each([
      ["of 200 characters whole", "x".repeat(200), "x".repeat(200)],
      [
        "of 201 characters cut to 200, the last an ellipsis",
        "x".repeat(201),
        `${"x".repeat(199)}…`
      ],
      [
        "cut inside a surrogate pair without either half of the pair",
        `${"x".repeat(198)}😀xx`,
        `${"x".repeat(198)}…`
      ]
    ])("shows a description %s", async (_label, description, shown) => {
      const result = await runKeeperTool(
        new ToolCatalog([buildNetworkToolDefinition("keep_note", description)]),
        SEARCH_TOOLS_TOOL_NAME,
        { query: "note" }
      )

      expect(result.content.split("\n")[1]).toBe(`- keep_note: ${shown}`)
    })

    it("says when no tool matches", async () => {
      const result = await runKeeperTool(
        new ToolCatalog(TOOLS),
        SEARCH_TOOLS_TOOL_NAME,
        { query: "weather" }
      )

      expect(result).toEqual({
        status: "succeeded",
        content:
          'No tool matches "weather". Search with other words, or recommend nothing if no tool fits.',
        sources: []
      })
    })

    it("searches with a query of 200 characters after trimming", async () => {
      const query = `note ${"a".repeat(195)}`

      const result = await runKeeperTool(
        new ToolCatalog(buildNoteTools(1)),
        SEARCH_TOOLS_TOOL_NAME,
        { query: `  ${query}  ` }
      )

      expect(result.content.split("\n")).toEqual([
        `Tools that match "${query}", best first:`,
        "- note_1: Keeps a note."
      ])
    })

    it.each([
      ["a blank query", "   "],
      ["a query of more than 200 characters", "a".repeat(201)],
      ["a query without words", "?! ..."]
    ])("refuses %s without searching", (_label, query) => {
      const catalog = new ToolCatalog(TOOLS)
      const listToolMatches = vi.spyOn(catalog, "listToolMatches")

      const parsed = parseKeeperToolCall(catalog, SEARCH_TOOLS_TOOL_NAME, {
        query
      })

      expect(parsed).toEqual({
        status: "invalid",
        message:
          "The query must be 1 to 200 characters long after trimming and hold at least one word."
      })
      expect(listToolMatches).not.toHaveBeenCalled()
    })
  })

  describe("recommend_tool", () => {
    registerBuiltInToolContractSuite(createRecommendToolHarness)

    it("recommends a tool of the turn and says how many are recommended", async () => {
      const catalog = new ToolCatalog(TOOLS)

      const result = await runKeeperTool(catalog, RECOMMEND_TOOL_TOOL_NAME, {
        name: "send_email"
      })

      expect(result).toEqual({
        status: "succeeded",
        content: `Recommended send_email: 1 of at most ${MAXIMUM_RECOMMENDED_TOOL_COUNT} tools.`,
        sources: []
      })
      expect(catalog.listRecommendedToolNames()).toEqual(["send_email"])
    })

    it("says a tool is already recommended", async () => {
      const catalog = new ToolCatalog(TOOLS)
      await runKeeperTool(catalog, RECOMMEND_TOOL_TOOL_NAME, {
        name: "read_page"
      })

      const result = await runKeeperTool(catalog, RECOMMEND_TOOL_TOOL_NAME, {
        name: "read_page"
      })

      expect(result).toEqual({
        status: "succeeded",
        content: "read_page is already recommended.",
        sources: []
      })
    })

    it("fails once the most tools are recommended", async () => {
      const tools = buildNoteTools(MAXIMUM_RECOMMENDED_TOOL_COUNT + 1)
      const catalog = new ToolCatalog(tools)
      for (const tool of tools.slice(0, MAXIMUM_RECOMMENDED_TOOL_COUNT))
        catalog.addRecommendedTool(tool.name)

      const result = await runKeeperTool(catalog, RECOMMEND_TOOL_TOOL_NAME, {
        name: `note_${MAXIMUM_RECOMMENDED_TOOL_COUNT + 1}`
      })

      expect(result).toEqual({
        status: "failed",
        content: `You already recommended ${MAXIMUM_RECOMMENDED_TOOL_COUNT} tools, the most for one search. Finish with one short sentence.`
      })
    })

    it("refuses a name that is not a tool of the turn without recommending", () => {
      const catalog = new ToolCatalog(TOOLS)
      const addRecommendedTool = vi.spyOn(catalog, "addRecommendedTool")

      const parsed = parseKeeperToolCall(catalog, RECOMMEND_TOOL_TOOL_NAME, {
        name: "read_file"
      })

      expect(parsed).toEqual({
        status: "invalid",
        message: `No tool is named "read_file". Recommend a name ${SEARCH_TOOLS_TOOL_NAME} listed, exactly as it listed it.`
      })
      expect(addRecommendedTool).not.toHaveBeenCalled()
    })
  })
})
