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
import { updateFastifyWithHttpTransport } from "../../../../../src/http"
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

/** Path of the key check. */
const KEY_CHECK_URL = "/api/v1/tools/web_search/key-check"

/** Origin of a web page open in the person's browser. */
const WEB_PAGE_ORIGIN = "https://attacker.example"

/**
 * Registers the tool routes, behind the backend's HTTP transport, over a web
 * search provider whose key reads give one result and whose requests would
 * reach a fake Tavily server.
 *
 * @param keyRead - What every key read gives.
 * @returns The application, and the server that records any request sent.
 */
async function createToolRouteApp(keyRead: TavilyApiKeyRead) {
  const server = await startTavilyServer(answerWithJson({}))
  const webSearchToolProvider = new WebSearchToolProvider(
    () => Promise.resolve(keyRead),
    server.dependencies
  )
  const { app } = createTestFastify()
  await updateFastifyWithHttpTransport(app)
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
    it("answers that no key is saved without contacting Tavily", async () => {
      const { app, server } = await createToolRouteApp({ status: "missing" })

      const response = await app.inject({
        method: "POST",
        url: KEY_CHECK_URL,
        payload: {}
      })

      expect(response.json()).toEqual({
        status: "unavailable",
        reason: "api-key-missing"
      })
      expect(server.receivedRequests).toHaveLength(0)
    })

    it("asks Tavily about the saved key for an empty JSON body, and never answers with the key", async () => {
      const { app, server } = await createToolRouteApp({
        status: "configured",
        apiKey: TEST_TAVILY_API_KEY
      })

      const response = await app.inject({
        method: "POST",
        url: KEY_CHECK_URL,
        payload: {}
      })

      expect(response.body.includes(TEST_TAVILY_API_KEY)).toBe(false)
      expect(response.statusCode).toBe(200)
      expect(
        checkWebSearchKeyApiResponseSchema.safeParse(response.json()).success
      ).toBe(true)
      expect(server.receivedRequests.map((request) => request.path)).toEqual([
        "/usage"
      ])
    })

    // Each is a request a web page can send to another origin without a
    // CORS preflight, so none may reach Tavily with the key.
    it.each([
      ["a GET", { method: "GET", headers: {} }, 404],
      ["a POST without a body", { method: "POST", headers: {} }, 400],
      [
        "a POST of plain text",
        {
          method: "POST",
          headers: { "content-type": "text/plain" },
          payload: "{}"
        },
        400
      ],
      [
        "a POST of a form",
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          payload: "check=1"
        },
        415
      ]
    ] as const)(
      "refuses %s before reading the key or contacting Tavily",
      async (_label, request, statusCode) => {
        const { app, server } = await createToolRouteApp({
          status: "configured",
          apiKey: TEST_TAVILY_API_KEY
        })

        const response = await app.inject({
          ...request,
          url: KEY_CHECK_URL,
          headers: { ...request.headers, origin: WEB_PAGE_ORIGIN }
        })

        expect(response.statusCode).toBe(statusCode)
        expect(server.receivedRequests).toHaveLength(0)
      }
    )

    it("refuses a JSON body that is not empty before contacting Tavily", async () => {
      const { app, server } = await createToolRouteApp({
        status: "configured",
        apiKey: TEST_TAVILY_API_KEY
      })

      const response = await app.inject({
        method: "POST",
        url: KEY_CHECK_URL,
        payload: { apiKey: "tvly-other" }
      })

      expect(response.statusCode).toBe(400)
      expect(server.receivedRequests).toHaveLength(0)
    })

    it("grants a web page's preflight for the JSON POST no access", async () => {
      const { app, server } = await createToolRouteApp({
        status: "configured",
        apiKey: TEST_TAVILY_API_KEY
      })

      const response = await app.inject({
        method: "OPTIONS",
        url: KEY_CHECK_URL,
        headers: {
          origin: WEB_PAGE_ORIGIN,
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type"
        }
      })

      expect(response.headers["access-control-allow-origin"]).toBeUndefined()
      expect(server.receivedRequests).toHaveLength(0)
    })
  })
})
