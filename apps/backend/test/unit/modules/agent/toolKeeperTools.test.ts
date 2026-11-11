import { toolDefinitionSchema, type ToolDefinition } from "@lys/share"
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

/**
 * Builds the definition of a backend tool that takes no argument.
 *
 * @param name - Name of the tool.
 * @param description - What the tool does.
 * @returns The validated definition.
 */
function buildDefinition(name: string, description: string): ToolDefinition {
  return toolDefinitionSchema.parse({
    name,
    description,
    group: "network",
    access: "network",
    runner: "backend",
    arguments: []
  })
}

/** Tools of the asking turn in most cases, in offer order. */
const TOOLS = Object.freeze([
  buildDefinition("read_page", "Reads one web page and returns its text."),
  buildDefinition("send_email", "Sends an email message to a recipient.")
])

/**
 * Finds one of the tool keeper's tools by name.
 *
 * @param catalog - Catalog of the search.
 * @param name - Name of the tool.
 * @returns The tool.
 * @throws If no tool has the name.
 */
function findKeeperTool(catalog: ToolCatalog, name: string): TurnBuiltInTool {
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
  const parsed = findKeeperTool(catalog, name).tool.parseToolCall(callArguments)
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
  return findKeeperTool(catalog, name).tool.parseToolCall(callArguments)
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
    registerBuiltInToolContractSuite(async (): Promise<BuiltInToolHarness> => {
      const catalog = new ToolCatalog(TOOLS)
      const listToolMatches = vi.spyOn(catalog, "listToolMatches")
      return {
        tool: findKeeperTool(catalog, SEARCH_TOOLS_TOOL_NAME).tool,
        runnableArguments: { query: "web page" },
        invalidArguments: { query: "   " },
        countStartedWork: () => listToolMatches.mock.calls.length
      }
    })

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

    it("says how many more tools match than it lists", async () => {
      const tools = Array.from(
        { length: MAXIMUM_LISTED_TOOL_COUNT + 3 },
        (_unused, index) =>
          buildDefinition(`note_${index + 1}`, "Keeps a note.")
      )

      const result = await runKeeperTool(
        new ToolCatalog(tools),
        SEARCH_TOOLS_TOOL_NAME,
        { query: "note" }
      )

      expect(result.content.split("\n")).toHaveLength(
        MAXIMUM_LISTED_TOOL_COUNT + 2
      )
      expect(result.content).toContain(
        "3 more tools match; search with other words to narrow the list."
      )
    })

    it("shows a description on one line, cut to 200 characters", async () => {
      const description = `Keeps\na  note. ${"x".repeat(300)}`

      const result = await runKeeperTool(
        new ToolCatalog([buildDefinition("keep_note", description)]),
        SEARCH_TOOLS_TOOL_NAME,
        { query: "note" }
      )

      const line = result.content.split("\n")[1] ?? ""
      expect(line.startsWith("- keep_note: Keeps a note. xxx")).toBe(true)
      expect(line).toHaveLength("- keep_note: ".length + 200)
      expect(line.endsWith("…")).toBe(true)
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
    registerBuiltInToolContractSuite(async (): Promise<BuiltInToolHarness> => {
      const catalog = new ToolCatalog(TOOLS)
      const recommendTool = vi.spyOn(catalog, "recommendTool")
      return {
        tool: findKeeperTool(catalog, RECOMMEND_TOOL_TOOL_NAME).tool,
        runnableArguments: { name: "read_page" },
        invalidArguments: { name: "read_file" },
        countStartedWork: () => recommendTool.mock.calls.length
      }
    })

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
      const tools = Array.from(
        { length: MAXIMUM_RECOMMENDED_TOOL_COUNT + 1 },
        (_unused, index) =>
          buildDefinition(`note_${index + 1}`, "Keeps a note.")
      )
      const catalog = new ToolCatalog(tools)
      for (const tool of tools.slice(0, MAXIMUM_RECOMMENDED_TOOL_COUNT))
        catalog.recommendTool(tool.name)

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
      const recommendTool = vi.spyOn(catalog, "recommendTool")

      const parsed = parseKeeperToolCall(catalog, RECOMMEND_TOOL_TOOL_NAME, {
        name: "read_file"
      })

      expect(parsed).toEqual({
        status: "invalid",
        message: `No tool is named "read_file". Recommend a name ${SEARCH_TOOLS_TOOL_NAME} listed, exactly as it listed it.`
      })
      expect(recommendTool).not.toHaveBeenCalled()
    })
  })
})
