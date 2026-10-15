import { checkWebSearchKeyApiResponseSchema } from "@lys/protocol"
import { describe, expect, it } from "vitest"
import {
  buildTavilyRequestDependencies,
  createBuiltInTools
} from "../../../../../src/modules/tool/builtIn/builtInTools"
import WebSearchToolProvider from "../../../../../src/modules/tool/builtIn/web/webSearchToolProvider"
import registerToolRoutes from "../../../../../src/modules/tool/routes"
import { updateFastifyWithHttpTransport } from "../../../../../src/http"
import { TEST_BACKEND_CONFIG } from "../../../../unit/support/backendConfig"
import { createTestFastify } from "../../../../unit/support/fastifyTestApp"
import { getLiveTavilyApiKey } from "../../../support/liveTavily"

describe("registerToolRoutes against the Tavily API", () => {
  describe("key check", () => {
    it("answers that Tavily accepted the saved key, with its credits", async () => {
      const apiKey = getLiveTavilyApiKey()
      const webSearchToolProvider = new WebSearchToolProvider(
        () => Promise.resolve({ status: "configured", apiKey }),
        buildTavilyRequestDependencies()
      )
      const { app } = createTestFastify()
      await updateFastifyWithHttpTransport(app)
      app.decorate("webSearchToolProvider", webSearchToolProvider)
      app.decorate(
        "builtInTools",
        createBuiltInTools(
          webSearchToolProvider,
          TEST_BACKEND_CONFIG.browserExecutablePath,
          () => undefined
        )
      )
      await registerToolRoutes(app)

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/tools/web_search/key-check",
        payload: {}
      })

      // Checked first, and as a Boolean, so no later failure can print a key.
      expect(response.body.includes(apiKey)).toBe(false)
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({
        status: "accepted",
        credits: { used: expect.any(Number) }
      })
      expect(
        checkWebSearchKeyApiResponseSchema.safeParse(response.json()).success
      ).toBe(true)
    })
  })
})
