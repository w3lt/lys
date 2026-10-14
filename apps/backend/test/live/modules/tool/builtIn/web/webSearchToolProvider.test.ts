import {
  checkWebSearchKeyApiResponseSchema,
  type CheckWebSearchKeyApiResponse
} from "@lys/protocol"
import type { TavilyApiKey } from "@lys/share"
import { describe, expect, it } from "vitest"
import { buildTavilyRequestDependencies } from "../../../../../../src/modules/tool/builtIn/builtInTools"
import WebSearchToolProvider from "../../../../../../src/modules/tool/builtIn/web/webSearchToolProvider"
import {
  getLiveTavilyApiKey,
  UNKNOWN_TAVILY_API_KEY
} from "../../../../support/liveTavily"

/**
 * Checks one key with the Tavily API, through the production request
 * settings.
 *
 * @param apiKey - Key every key read gives.
 * @returns The check's answer.
 */
function sendLiveApiKeyCheck(
  apiKey: TavilyApiKey
): Promise<CheckWebSearchKeyApiResponse> {
  return new WebSearchToolProvider(
    () => Promise.resolve({ status: "configured", apiKey }),
    buildTavilyRequestDependencies()
  ).sendApiKeyCheck()
}

describe("WebSearchToolProvider against the Tavily API", () => {
  describe("sendApiKeyCheck", () => {
    it("reports the real key as accepted with its plan credits, without the key", async () => {
      const apiKey = getLiveTavilyApiKey()

      const answer = await sendLiveApiKeyCheck(apiKey)

      // Checked first, and as a Boolean, so no later failure can print a key.
      expect(JSON.stringify(answer).includes(apiKey)).toBe(false)
      expect(answer).toMatchObject({
        status: "accepted",
        credits: { used: expect.any(Number) }
      })
      expect(checkWebSearchKeyApiResponseSchema.safeParse(answer).success).toBe(
        true
      )
    })

    it("reports a key Tavily never issued as rejected", async () => {
      expect(await sendLiveApiKeyCheck(UNKNOWN_TAVILY_API_KEY)).toEqual({
        status: "rejected"
      })
    })
  })
})
