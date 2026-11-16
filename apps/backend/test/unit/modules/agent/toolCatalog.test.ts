import { describe, expect, it } from "vitest"
import ToolCatalog, {
  MAXIMUM_LISTED_TOOL_COUNT,
  MAXIMUM_RECOMMENDED_TOOL_COUNT
} from "../../../../src/modules/agent/toolCatalog"
import {
  buildNetworkToolDefinition,
  buildNoteTools
} from "../../support/toolFixtures"

/**
 * Tools of the asking turn in most cases, in offer order; `web_search` comes
 * before `read_page`, which matches "read web page" better.
 */
const TOOLS = Object.freeze([
  buildNetworkToolDefinition(
    "web_search",
    "Searches the web and lists the results."
  ),
  buildNetworkToolDefinition(
    "read_page",
    "Reads one web page and returns its text."
  ),
  buildNetworkToolDefinition(
    "send_email",
    "Sends an email message to a recipient."
  ),
  buildNetworkToolDefinition(
    "get_time",
    "Tells the current time and time zone."
  )
])

describe("ToolCatalog", () => {
  describe("listToolMatches", () => {
    it("lists the tools whose name or description matches, best first whatever the offer order", () => {
      const catalog = new ToolCatalog(TOOLS)

      const result = catalog.listToolMatches("read web page")

      expect(result.matches.map((tool) => tool.name)).toEqual([
        "read_page",
        "web_search"
      ])
      expect(result.matchCount).toBe(2)
    })

    it.each([
      ["its name", "invoices", ["list_invoices"]],
      ["its description", "dictionary", ["lookup"]],
      ["its group", "network", ["list_invoices", "lookup"]]
    ])("finds a tool by a word only %s holds", (_field, query, toolNames) => {
      const catalog = new ToolCatalog([
        buildNetworkToolDefinition("list_invoices", "Shows what is owed."),
        buildNetworkToolDefinition("lookup", "Finds a term in the dictionary.")
      ])

      expect(
        catalog.listToolMatches(query).matches.map((tool) => tool.name)
      ).toEqual(toolNames)
    })

    it.each([
      ["a snake_case name by one of its words", "email", "send_email"],
      ["a snake_case name by the whole name", "send_email", "send_email"],
      ["a kebab-case name by one of its words", "calendar", "open-calendar"],
      ["a camelCase name by one of its words", "issue", "createIssue"],
      ["a camelCase name by the whole name", "createIssue", "createIssue"],
      ["a name with an acronym by the word after it", "page", "readHTMLPage"],
      ["a name with an acronym by the acronym", "html", "readHTMLPage"],
      ["a name with a digit by the word after it", "upload", "s3Upload"]
    ])("finds %s", (_label, query, toolName) => {
      const catalog = new ToolCatalog([
        buildNetworkToolDefinition("send_email", "Sends a message."),
        buildNetworkToolDefinition("open-calendar", "Shows the week."),
        buildNetworkToolDefinition("createIssue", "Opens a ticket."),
        buildNetworkToolDefinition("readHTMLPage", "Loads a site."),
        buildNetworkToolDefinition("s3Upload", "Stores a file.")
      ])

      expect(
        catalog.listToolMatches(query).matches.map((tool) => tool.name)
      ).toEqual([toolName])
    })

    it.each([
      ["a mixed-case word its description holds", "GitHub", "open_ticket"],
      ["the same word in lowercase", "github", "open_ticket"],
      ["a plural acronym its description holds", "PDFs", "read_document"],
      [
        "a mixed-case word a part of its name holds",
        "GitLab",
        "gitlab_create_issue"
      ],
      ["an acronym before As in its name", "pdf", "exportPDFAsImage"],
      ["an acronym before Is in its name", "url", "checkURLIsValid"]
    ])("finds a tool by %s", (_label, query, toolName) => {
      const catalog = new ToolCatalog([
        buildNetworkToolDefinition("open_ticket", "Opens a ticket on GitHub."),
        buildNetworkToolDefinition("read_document", "Reads PDFs."),
        buildNetworkToolDefinition("gitlab_create_issue", "Creates a record."),
        buildNetworkToolDefinition("exportPDFAsImage", "Saves a page."),
        buildNetworkToolDefinition("checkURLIsValid", "Checks a link.")
      ])

      expect(
        catalog.listToolMatches(query).matches.map((tool) => tool.name)
      ).toEqual([toolName])
    })

    it("splits a capital run before an s like before any lowercase letter, so a plural acronym in a name is not found by its plural", () => {
      const catalog = new ToolCatalog([
        buildNetworkToolDefinition("getURLs", "Lists the links of a page.")
      ])

      expect(catalog.listToolMatches("urls").matches).toEqual([])
      expect(
        catalog.listToolMatches("ls").matches.map((tool) => tool.name)
      ).toEqual(["getURLs"])
    })

    it("counts a name of one word once, so it ties with a description that holds the word", () => {
      const catalog = new ToolCatalog([
        buildNetworkToolDefinition("list", "Stores your notes."),
        buildNetworkToolDefinition("notes", "Stores your list.")
      ])

      expect(
        catalog.listToolMatches("notes").matches.map((tool) => tool.name)
      ).toEqual(["list", "notes"])
    })

    it.each([["email"], ["send email"], ["send_email"]])(
      "ranks a kebab-case name as the snake_case name of the same words, so the two tie in offer order for the query %s",
      (query) => {
        const description = "Sends a message."
        const catalog = new ToolCatalog([
          buildNetworkToolDefinition("send_email", description),
          buildNetworkToolDefinition("send-email", description)
        ])

        expect(
          catalog.listToolMatches(query).matches.map((tool) => tool.name)
        ).toEqual(["send_email", "send-email"])
      }
    )

    it("weighs a word the query repeats once", () => {
      const catalog = new ToolCatalog([
        buildNetworkToolDefinition("beta", "Prints page."),
        buildNetworkToolDefinition("gamma", "Folds page."),
        buildNetworkToolDefinition("alpha", "Fetches web.")
      ])

      const result = catalog.listToolMatches("web page page page")

      expect(result.matches.map((tool) => tool.name)).toEqual([
        "alpha",
        "beta",
        "gamma"
      ])
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

  describe("addRecommendedTool", () => {
    it("recommends tools in the order they were recommended, each once", () => {
      const catalog = new ToolCatalog(TOOLS)

      expect(catalog.addRecommendedTool("web_search")).toEqual({
        status: "recommended",
        recommendedCount: 1
      })
      expect(catalog.addRecommendedTool("read_page")).toEqual({
        status: "recommended",
        recommendedCount: 2
      })
      expect(catalog.addRecommendedTool("web_search")).toEqual({
        status: "already-recommended"
      })
      expect(catalog.listRecommendedToolNames()).toEqual([
        "web_search",
        "read_page"
      ])
    })

    it("recommends nothing that is not a tool of the turn", () => {
      const catalog = new ToolCatalog(TOOLS)

      expect(catalog.addRecommendedTool("read_file")).toEqual({
        status: "unknown"
      })
      expect(catalog.listRecommendedToolNames()).toEqual([])
    })

    it(`recommends at most ${MAXIMUM_RECOMMENDED_TOOL_COUNT} tools`, () => {
      const tools = buildNoteTools(MAXIMUM_RECOMMENDED_TOOL_COUNT + 1)
      const catalog = new ToolCatalog(tools)
      for (const tool of tools.slice(0, MAXIMUM_RECOMMENDED_TOOL_COUNT))
        catalog.addRecommendedTool(tool.name)

      const outcome = catalog.addRecommendedTool(
        `note_${MAXIMUM_RECOMMENDED_TOOL_COUNT + 1}`
      )

      expect(outcome).toEqual({ status: "full" })
      expect(catalog.listRecommendedToolNames()).toHaveLength(
        MAXIMUM_RECOMMENDED_TOOL_COUNT
      )
    })

    it("returns a frozen list that later recommendations leave as it was", () => {
      const catalog = new ToolCatalog(TOOLS)
      catalog.addRecommendedTool("read_page")
      const names = catalog.listRecommendedToolNames()

      catalog.addRecommendedTool("get_time")

      expect(Object.isFrozen(names)).toBe(true)
      expect(names).toEqual(["read_page"])
    })
  })
})
