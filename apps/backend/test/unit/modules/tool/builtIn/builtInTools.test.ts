import { describe, expect, it } from "vitest"
import type { BuiltInToolEntry } from "../../../../../src/modules/tool/builtIn/builtInTool"
import {
  buildTavilyRequestDependencies,
  createBuiltInTools,
  findBuiltInTools,
  prepareBuiltInTools
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

/** Web search provider that is never ready. */
const UNAVAILABLE_PROVIDER = new ScriptedBuiltInToolProvider({
  status: "unavailable",
  reason: "api-key-missing"
})

/** Scripted look-up tool, always ready. */
const LOOK_UP_TOOL = new ScriptedBuiltInTool()

/** Read page, web search (unavailable), then the scripted look-up tool. */
const ENTRIES: readonly BuiltInToolEntry[] = Object.freeze([
  ...createBuiltInTools(UNAVAILABLE_PROVIDER),
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
    const entries = createBuiltInTools(UNAVAILABLE_PROVIDER)

    expect(entries.map((entry) => entry.definition)).toEqual([
      buildReadPageDefinition(),
      buildWebSearchDefinition()
    ])
    expect(entries[1]?.provider).toBe(UNAVAILABLE_PROVIDER)
    expect(Object.isFrozen(entries)).toBe(true)
  })

  it("gives every turn the read-page tool, which refuses this machine", async () => {
    const [readPage] = createBuiltInTools(UNAVAILABLE_PROVIDER)

    const preparation = await readPage?.provider.prepareTool()

    expect(preparation?.status === "ready" && preparation.tool).toBeInstanceOf(
      ReadPageTool
    )
    const parsed =
      preparation?.status === "ready"
        ? preparation.tool.parseToolCall({ url: "http://[::1]/" })
        : undefined
    expect(parsed).toMatchObject({ status: "invalid" })
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

describe("prepareBuiltInTools", () => {
  it("prepares nothing for a request that offers no backend tool", async () => {
    expect(await prepareBuiltInTools([])).toEqual({
      status: "ready",
      tools: []
    })
  })

  it("prepares every offered tool in offer order", async () => {
    const entries = [ENTRIES[2], ENTRIES[0]].filter(
      (entry) => entry !== undefined
    )

    const preparation = await prepareBuiltInTools(entries)

    expect(preparation.status).toBe("ready")
    const tools = preparation.status === "ready" ? preparation.tools : []
    expect(tools.map((tool) => tool.definition.name)).toEqual([
      "look_up_word",
      "read_page"
    ])
    expect(tools[0]?.tool).toBe(LOOK_UP_TOOL)
  })

  it("names the first offered tool that cannot run, with why", async () => {
    expect(await prepareBuiltInTools(ENTRIES)).toEqual({
      status: "unavailable",
      toolName: "web_search",
      reason: "api-key-missing"
    })
  })
})
