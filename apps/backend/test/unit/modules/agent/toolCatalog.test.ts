import { toolDefinitionSchema, type ToolDefinition } from "@lys/share"
import { describe, expect, it } from "vitest"
import ToolCatalog, {
  MAXIMUM_LISTED_TOOL_COUNT,
  MAXIMUM_RECOMMENDED_TOOL_COUNT
} from "../../../../src/modules/agent/toolCatalog"

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
  buildDefinition("web_search", "Searches the web and lists the results."),
  buildDefinition("send_email", "Sends an email message to a recipient."),
  buildDefinition("get_time", "Tells the current time and time zone.")
])

/**
 * Builds as many tools as a search can list, plus extra ones, all matching
 * the same word.
 *
 * @param count - Number of tools.
 * @returns Tools named `note_1` up, each about notes.
 */
function buildNoteTools(count: number): readonly ToolDefinition[] {
  return Array.from({ length: count }, (_unused, index) =>
    buildDefinition(`note_${index + 1}`, "Keeps a note.")
  )
}

describe("ToolCatalog", () => {
  describe("listToolMatches", () => {
    it("lists the tools whose name or description matches, best first", () => {
      const catalog = new ToolCatalog(TOOLS)

      const result = catalog.listToolMatches("read web page")

      expect(result.matches.map((tool) => tool.name)).toEqual([
        "read_page",
        "web_search"
      ])
      expect(result.matchCount).toBe(2)
    })

    it("finds a tool by the words of its name", () => {
      const catalog = new ToolCatalog(TOOLS)

      expect(
        catalog.listToolMatches("email").matches.map((tool) => tool.name)
      ).toEqual(["send_email"])
    })

    it("ignores case and punctuation", () => {
      const catalog = new ToolCatalog(TOOLS)

      expect(
        catalog.listToolMatches("TIME?!").matches.map((tool) => tool.name)
      ).toEqual(["get_time"])
    })

    it("lists nothing for words no tool holds", () => {
      const catalog = new ToolCatalog(TOOLS)

      expect(catalog.listToolMatches("weather forecast")).toEqual({
        matches: [],
        matchCount: 0
      })
    })

    it("lists nothing for a query without words, or for a turn without tools", () => {
      expect(new ToolCatalog(TOOLS).listToolMatches("?!")).toEqual({
        matches: [],
        matchCount: 0
      })
      expect(new ToolCatalog([]).listToolMatches("email")).toEqual({
        matches: [],
        matchCount: 0
      })
    })

    it(`lists at most ${MAXIMUM_LISTED_TOOL_COUNT} tools, ties in offer order, and counts every match`, () => {
      const tools = buildNoteTools(MAXIMUM_LISTED_TOOL_COUNT + 2)
      const catalog = new ToolCatalog(tools)

      const result = catalog.listToolMatches("note")

      expect(result.matches).toEqual(tools.slice(0, MAXIMUM_LISTED_TOOL_COUNT))
      expect(result.matchCount).toBe(MAXIMUM_LISTED_TOOL_COUNT + 2)
      expect(Object.isFrozen(result)).toBe(true)
      expect(Object.isFrozen(result.matches)).toBe(true)
    })
  })

  describe("hasTool", () => {
    it("answers whether the turn has a tool of the exact name", () => {
      const catalog = new ToolCatalog(TOOLS)

      expect(catalog.hasTool("read_page")).toBe(true)
      expect(catalog.hasTool("READ_PAGE")).toBe(false)
      expect(catalog.hasTool("read_file")).toBe(false)
    })
  })

  describe("recommendTool", () => {
    it("recommends tools in the order they were recommended, each once", () => {
      const catalog = new ToolCatalog(TOOLS)

      expect(catalog.recommendTool("web_search")).toEqual({
        status: "recommended",
        recommendedCount: 1
      })
      expect(catalog.recommendTool("read_page")).toEqual({
        status: "recommended",
        recommendedCount: 2
      })
      expect(catalog.recommendTool("web_search")).toEqual({
        status: "already-recommended"
      })
      expect(catalog.listRecommendedToolNames()).toEqual([
        "web_search",
        "read_page"
      ])
    })

    it("recommends nothing that is not a tool of the turn", () => {
      const catalog = new ToolCatalog(TOOLS)

      expect(catalog.recommendTool("read_file")).toEqual({ status: "unknown" })
      expect(catalog.listRecommendedToolNames()).toEqual([])
    })

    it(`recommends at most ${MAXIMUM_RECOMMENDED_TOOL_COUNT} tools`, () => {
      const tools = buildNoteTools(MAXIMUM_RECOMMENDED_TOOL_COUNT + 1)
      const catalog = new ToolCatalog(tools)
      for (const tool of tools.slice(0, MAXIMUM_RECOMMENDED_TOOL_COUNT))
        catalog.recommendTool(tool.name)

      const outcome = catalog.recommendTool(
        `note_${MAXIMUM_RECOMMENDED_TOOL_COUNT + 1}`
      )

      expect(outcome).toEqual({ status: "full" })
      expect(catalog.listRecommendedToolNames()).toHaveLength(
        MAXIMUM_RECOMMENDED_TOOL_COUNT
      )
    })

    it("returns a frozen list that later recommendations leave as it was", () => {
      const catalog = new ToolCatalog(TOOLS)
      catalog.recommendTool("read_page")
      const names = catalog.listRecommendedToolNames()

      catalog.recommendTool("get_time")

      expect(Object.isFrozen(names)).toBe(true)
      expect(names).toEqual(["read_page"])
    })
  })
})
