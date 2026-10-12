import {
  checkWebSearchKeyApiResponseSchema,
  listBackendToolsApiResponseSchema
} from "@lys/protocol"
import { describe, expect, it } from "vitest"
import { createBuiltInTools } from "../../../../../src/modules/tool/builtIn/builtInTools"
import { buildReadPageDefinition } from "../../../../../src/modules/tool/builtIn/web/readPageTool"
import WebSearchToolProvider from "../../../../../src/modules/tool/builtIn/web/webSearchToolProvider"
import { buildWebSearchDefinition } from "../../../../../src/modules/tool/builtIn/web/webSearchTool"
import registerToolRoutes from "../../../../../src/modules/tool/routes"
import type { TavilyApiKeyRead } from "../../../../../src/infrastructure/settings/tavilyApiKeyFile"
import { createTestFastify } from "../../../support/fastifyTestApp"
import {
  LOOK_UP_WORD_TOOL,
  ScriptedBuiltInTool
} from "../../../support/scriptedBuiltInTool"
import { ScriptedBuiltInToolProvider } from "../../../support/scriptedBuiltInToolProvider"
import {
  answerWithJson,
  startTavilyServer,
  TEST_TAVILY_API_KEY
} from "../../../support/tavilyServer"

/**
 * Registers the tool routes over a web search provider whose key reads give
 * one result and whose requests reach a fake Tavily server.
 *
 * @param keyRead - What every key read gives.
 * @returns The application.
 */
async function createToolRouteApp(keyRead: TavilyApiKeyRead) {
  const server = await startTavilyServer(
    answerWithJson({ account: { plan_usage: 5, plan_limit: 1000 } })
  )
  const webSearchToolProvider = new WebSearchToolProvider(
    () => Promise.resolve(keyRead),
    server.dependencies
  )
  const { app } = createTestFastify()
  app.decorate("webSearchToolProvider", webSearchToolProvider)
  app.decorate("builtInTools", [
    ...createBuiltInTools(webSearchToolProvider),
    {
      definition: LOOK_UP_WORD_TOOL,
      provider: new ScriptedBuiltInToolProvider({
        status: "ready",
        tool: new ScriptedBuiltInTool()
      })
    }
  ])
  await registerToolRoutes(app)
  return { app, server }
}

describe("registerToolRoutes", () => {
  describe("tool list", () => {
    it("lists every definition in order and names web_search unavailable without a key", async () => {
      const { app } = await createToolRouteApp({ status: "missing" })

      const response = await app.inject({ method: "GET", url: "/api/v1/tools" })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({
        tools: [
          buildReadPageDefinition(),
          buildWebSearchDefinition(),
          LOOK_UP_WORD_TOOL
        ],
        unavailableTools: [{ name: "web_search", reason: "api-key-missing" }]
      })
      expect(
        listBackendToolsApiResponseSchema.safeParse(response.json()).success
      ).toBe(true)
    })

    it("names no unavailable tool once a key is saved, and never sends the key", async () => {
      const { app } = await createToolRouteApp({
        status: "configured",
        apiKey: TEST_TAVILY_API_KEY
      })

      const response = await app.inject({ method: "GET", url: "/api/v1/tools" })

      expect(response.json()).toMatchObject({ unavailableTools: [] })
      expect(response.body).not.toContain(TEST_TAVILY_API_KEY)
    })

    it("registers the tools path for GET only", async () => {
      const { app } = await createToolRouteApp({ status: "missing" })

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/tools"
      })

      expect(response.statusCode).toBe(404)
    })
  })

  describe("key check", () => {
    it("answers that Tavily accepted the saved key, with its credits", async () => {
      const { app, server } = await createToolRouteApp({
        status: "configured",
        apiKey: TEST_TAVILY_API_KEY
      })

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/tools/web_search/key-check"
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({
        status: "accepted",
        credits: { used: 5, limit: 1000 }
      })
      expect(
        checkWebSearchKeyApiResponseSchema.safeParse(response.json()).success
      ).toBe(true)
      expect(response.body).not.toContain(TEST_TAVILY_API_KEY)
      expect(server.receivedRequests[0]?.path).toBe("/usage")
    })

    it("answers that no key is saved without contacting Tavily", async () => {
      const { app, server } = await createToolRouteApp({ status: "missing" })

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/tools/web_search/key-check"
      })

      expect(response.json()).toEqual({
        status: "unavailable",
        reason: "api-key-missing"
      })
      expect(server.receivedRequests).toHaveLength(0)
    })

    it("registers the key-check path for GET only", async () => {
      const { app } = await createToolRouteApp({ status: "missing" })

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/tools/web_search/key-check"
      })

      expect(response.statusCode).toBe(404)
    })
  })
})
