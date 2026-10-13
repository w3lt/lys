import { describe, expect, it } from "vitest"
import { buildTavilyRequestDependencies } from "../../../../../../src/modules/tool/builtIn/builtInTools"
import {
  MAXIMUM_SEARCH_RESULTS,
  sendTavilySearchRequest,
  sendTavilyUsageRequest
} from "../../../../../../src/modules/tool/builtIn/web/tavilyApi"
import { getLiveTavilyApiKey } from "../../../../support/liveTavily"

describe("sendTavilySearchRequest against the Tavily API", () => {
  it("keeps only the title, URL, and content of at most five real results", async () => {
    const outcome = await sendTavilySearchRequest(
      { query: "moths", apiKey: getLiveTavilyApiKey() },
      new AbortController().signal,
      buildTavilyRequestDependencies()
    )

    expect(outcome).toMatchObject({ status: "succeeded" })
    const results = outcome.status === "succeeded" ? outcome.results : []
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results.length).toBeLessThanOrEqual(MAXIMUM_SEARCH_RESULTS)
    expect(results).toEqual(
      results.map(() => ({
        title: expect.any(String),
        url: expect.any(String),
        content: expect.any(String)
      }))
    )
    expect(Object.isFrozen(results)).toBe(true)
  })
})

describe("sendTavilyUsageRequest against the Tavily API", () => {
  it("reads the account's plan credits as whole credits", async () => {
    const outcome = await sendTavilyUsageRequest(
      getLiveTavilyApiKey(),
      new AbortController().signal,
      buildTavilyRequestDependencies()
    )

    expect(outcome).toMatchObject({
      status: "succeeded",
      credits: { used: expect.any(Number) }
    })
    const credits = outcome.status === "succeeded" ? outcome.credits : null
    expect(Number.isSafeInteger(credits?.used)).toBe(true)
    expect(
      credits?.limit === null || Number.isSafeInteger(credits?.limit)
    ).toBe(true)
  })
})
