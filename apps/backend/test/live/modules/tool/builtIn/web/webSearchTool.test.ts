import { describe, expect, it } from "vitest"
import { buildTavilyRequestDependencies } from "../../../../../../src/modules/tool/builtIn/builtInTools"
import WebSearchTool from "../../../../../../src/modules/tool/builtIn/web/webSearchTool"
import { getLiveTavilyApiKey } from "../../../../support/liveTavily"

describe("WebSearchTool against the Tavily API", () => {
  it("frames real results under the trimmed query, without the key", async () => {
    const apiKey = getLiveTavilyApiKey()
    const tool = new WebSearchTool(apiKey, buildTavilyRequestDependencies())
    const parsed = tool.parseToolCall({ query: "  night moths\n " })
    if (parsed.status !== "parsed") throw new Error(parsed.message)

    const result = await parsed.runToolCall(new AbortController().signal)

    // Checked first, and as a Boolean, so no later failure can print a key.
    expect(result.content.includes(apiKey)).toBe(false)
    expect(result).toMatchObject({ status: "succeeded" })
    expect(result.content).toContain('Search: "night moths" (sent to Tavily)')
    expect(result.content).toMatch(/\nTitle: .*\nURL: https?:\/\/\S+\n/)
  })
})
