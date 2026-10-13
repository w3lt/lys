import { describe, expect, it } from "vitest"
import { buildTavilyRequestDependencies } from "../../../../../../src/modules/tool/builtIn/builtInTools"
import { sendTavilyRequest } from "../../../../../../src/modules/tool/builtIn/web/tavilyRequest"
import { getLiveTavilyApiKey } from "../../../../support/liveTavily"

describe("sendTavilyRequest against the Tavily API", () => {
  it("parses Tavily's JSON answer to a usage request", async () => {
    const result = await sendTavilyRequest(
      { method: "GET", path: "/usage", apiKey: getLiveTavilyApiKey() },
      new AbortController().signal,
      buildTavilyRequestDependencies()
    )

    expect(result).toMatchObject({
      status: "succeeded",
      body: expect.any(Object)
    })
  })
})
