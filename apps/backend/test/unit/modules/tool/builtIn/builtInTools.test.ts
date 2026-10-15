import { describe, expect, it, vi } from "vitest"
import type { BuiltInToolEntry } from "../../../../../src/modules/tool/builtIn/builtInTool"
import {
  buildTavilyRequestDependencies,
  createBuiltInTools,
  findBuiltInTools,
  findTurnBuiltInTools
} from "../../../../../src/modules/tool/builtIn/builtInTools"
import ReadPageTool, {
  buildReadPageDefinition
} from "../../../../../src/modules/tool/builtIn/web/readPageTool"
import { buildWebSearchDefinition } from "../../../../../src/modules/tool/builtIn/web/webSearchTool"
import {
  LOOK_UP_WORD_TOOL,
  ScriptedBuiltInTool
} from "../../../support/scriptedBuiltInTool"
import { ScriptedBuiltInToolProvider } from "../../../support/scriptedBuiltInToolProvider"

/** Browser path where no browser is installed. */
const MISSING_BROWSER_PATH = "/nonexistent/lys-test/chrome-headless-shell"

/** Ignores the cause of a browser failure, which these cases do not check. */
const IGNORE_BROWSER_FAILURE = () => undefined

/** Web search provider that is never ready. */
const UNAVAILABLE_PROVIDER = new ScriptedBuiltInToolProvider({
  status: "unavailable",
  reason: "api-key-missing"
})

/** Scripted look-up tool, always ready. */
const LOOK_UP_TOOL = new ScriptedBuiltInTool()

/** Read page, web search (unavailable), then the scripted look-up tool. */
const ENTRIES: readonly BuiltInToolEntry[] = Object.freeze([
  ...createBuiltInTools(
    UNAVAILABLE_PROVIDER,
    MISSING_BROWSER_PATH,
    IGNORE_BROWSER_FAILURE
  ),
  Object.freeze({
    definition: LOOK_UP_WORD_TOOL,
    provider: new ScriptedBuiltInToolProvider({
      status: "ready",
      tool: LOOK_UP_TOOL
    })
  })
])

describe("createBuiltInTools", () => {
  it("lists read_page, then web_search with the given provider, frozen", () => {
    const entries = createBuiltInTools(
      UNAVAILABLE_PROVIDER,
      MISSING_BROWSER_PATH,
      IGNORE_BROWSER_FAILURE
    )

    expect(entries.map((entry) => entry.definition)).toEqual([
      buildReadPageDefinition(),
      buildWebSearchDefinition()
    ])
    expect(entries[1]?.provider).toBe(UNAVAILABLE_PROVIDER)
    expect(Object.isFrozen(entries)).toBe(true)
  })

  it("gives every turn the read-page tool, which refuses this machine", async () => {
    const [readPage] = createBuiltInTools(
      UNAVAILABLE_PROVIDER,
      MISSING_BROWSER_PATH,
      IGNORE_BROWSER_FAILURE
    )

    const lookup = await readPage?.provider.findTurnTool()

    expect(lookup?.status === "ready" && lookup.tool).toBeInstanceOf(
      ReadPageTool
    )
    const parsed =
      lookup?.status === "ready"
        ? lookup.tool.parseToolCall({ url: "http://[::1]/" })
        : undefined
    expect(parsed).toMatchObject({ status: "invalid" })
  })

  it("gives the read-page tool the browser it is created with, and reports why it is missing", async () => {
    const reportBrowserFailure = vi.fn()
    const [readPage] = createBuiltInTools(
      UNAVAILABLE_PROVIDER,
      MISSING_BROWSER_PATH,
      reportBrowserFailure
    )
    const lookup = await readPage?.provider.findTurnTool()
    if (lookup?.status !== "ready") throw new Error("Expected a ready tool")
    const parsed = lookup.tool.parseToolCall({ url: "https://example.com/" })
    if (parsed.status !== "parsed") throw new Error("Expected a parsed call")

    const result = await parsed.runToolCall(new AbortController().signal)

    expect(result).toEqual({
      status: "failed",
      content:
        "Lys could not read https://example.com/: Lys's browser is missing. Please contact w3lt@negentropy.studio to report problem and require help. Only repair it yourself if you know exactly what you are doing."
    })
    expect(reportBrowserFailure).toHaveBeenCalledTimes(1)
    expect(reportBrowserFailure.mock.calls[0]?.[0]).toMatchObject({
      code: "ENOENT"
    })
  })
})

describe("buildTavilyRequestDependencies", () => {
  it("sends every request over HTTPS to Tavily with the production address rule and time limit", () => {
    const dependencies = buildTavilyRequestDependencies()

    expect(dependencies.origin).toBe("https://api.tavily.com")
    expect(dependencies.requestTimeoutMs).toBe(15_000)
    expect(dependencies.isBlockedAddress("127.0.0.1")).toBe(true)
    expect(dependencies.isBlockedAddress("192.168.1.10")).toBe(true)
  })
})

describe("findBuiltInTools", () => {
  it("finds nothing when the request names no backend tool", () => {
    expect(findBuiltInTools(ENTRIES, undefined)).toEqual({
      status: "found",
      entries: []
    })
  })

  it("finds the named tools in the order the request named them", () => {
    expect(findBuiltInTools(ENTRIES, ["look_up_word", "read_page"])).toEqual({
      status: "found",
      entries: [ENTRIES[2], ENTRIES[0]]
    })
  })

  it("names every tool the backend does not have", () => {
    expect(
      findBuiltInTools(ENTRIES, ["read_page", "read_text_file", "fetch_url"])
    ).toEqual({
      status: "unknown",
      toolNames: ["read_text_file", "fetch_url"]
    })
  })
})

describe("findTurnBuiltInTools", () => {
  it("finds nothing for a request that offers no backend tool", async () => {
    expect(await findTurnBuiltInTools([])).toEqual({
      status: "ready",
      tools: []
    })
  })

  it("finds every offered tool in offer order", async () => {
    const entries = [ENTRIES[2], ENTRIES[0]].filter(
      (entry) => entry !== undefined
    )

    const lookup = await findTurnBuiltInTools(entries)

    expect(lookup.status).toBe("ready")
    const tools = lookup.status === "ready" ? lookup.tools : []
    expect(tools.map((tool) => tool.definition.name)).toEqual([
      "look_up_word",
      "read_page"
    ])
    expect(tools[0]?.tool).toBe(LOOK_UP_TOOL)
  })

  it("names the first offered tool that cannot run, with why", async () => {
    expect(await findTurnBuiltInTools(ENTRIES)).toEqual({
      status: "unavailable",
      toolName: "web_search",
      reason: "api-key-missing"
    })
  })
})
