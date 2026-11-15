import {
  checkWebSearchKeyApiResponseSchema,
  listBackendToolsApiResponseSchema
} from "@lys/protocol"
import {
  DELEGATE_WORK_TOOL_NAME,
  mcpSettingsSchema,
  REPORT_PROGRESS_TOOL_NAME,
  STOP_JOB_TOOL_NAME,
  type McpServerSettings
} from "@lys/share"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import { buildListedDelegationDefinitions } from "../../../../../src/modules/agent/delegationTools"
import { openMcpServer } from "../../../../../src/modules/mcp/mcpServerOpening"
import type { McpServerEvent } from "../../../../../src/modules/mcp/mcpServerEvent"
import McpServerRegistry from "../../../../../src/modules/mcp/mcpServerRegistry"
import { createBuiltInTools } from "../../../../../src/modules/tool/builtIn/builtInTools"
import { buildReadPageDefinition } from "../../../../../src/modules/tool/builtIn/web/readPageTool"
import WebSearchToolProvider from "../../../../../src/modules/tool/builtIn/web/webSearchToolProvider"
import { buildWebSearchDefinition } from "../../../../../src/modules/tool/builtIn/web/webSearchTool"
import registerToolRoutes from "../../../../../src/modules/tool/routes"
import { updateFastifyWithHttpTransport } from "../../../../../src/http"
import type { TavilyApiKeyRead } from "../../../../../src/infrastructure/settings/tavilyApiKeyFile"
import { createTestFastify } from "../../../support/fastifyTestApp"
import {
  answerAsMcpServer,
  buildHttpServerSettings,
  startFakeMcpHttpServer
} from "../../../support/mcpTestServers"
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
import {
  answerWithBody,
  findClosedVmoOrigin,
  startVmoServer
} from "../../../support/vmoServer"
import { createOwnedMcpServerProcessGroups } from "../../../support/mcpServerProcessGroups"

/** Path of the key check. */
const KEY_CHECK_URL = "/api/v1/tools/web_search/key-check"

/** Origin of a web page open in the person's browser. */
const WEB_PAGE_ORIGIN = "https://attacker.example"

/** Longest one test opening of an MCP server may take. */
const MCP_OPENING_TIMEOUT_MILLISECONDS = 10_000

/**
 * Tool a fake MCP server lists, whose input schema uses keywords beyond
 * `type`, `properties`, and `required`, nested.
 */
const FIND_NOTES_TOOL = Object.freeze({
  name: "find.notes",
  description: "Finds notes.",
  inputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({
      query: Object.freeze({ type: "string", description: "Words to find." }),
      limit: Object.freeze({ type: "integer", minimum: 1, maximum: 10 }),
      tags: Object.freeze({
        type: "array",
        items: Object.freeze({ type: "string" })
      }),
      filter: Object.freeze({
        type: "object",
        properties: Object.freeze({
          after: Object.freeze({ type: "string", format: "date" })
        }),
        additionalProperties: false
      })
    }),
    required: Object.freeze(["query"]),
    additionalProperties: false
  })
})

/**
 * Starts a fake vmo that answers its health route, so it can read pages.
 *
 * @returns The fake vmo's origin.
 */
async function startHealthyVmo(): Promise<string> {
  const vmo = await startVmoServer(
    answerWithBody(200, "text/plain; charset=utf-8", "ok\n")
  )
  return vmo.origin
}

/**
 * Creates an MCP server registry whose settings name these servers and
 * whose openings reach them as production does, closed when the case
 * finishes.
 *
 * @param servers - Servers in settings order; none when omitted.
 * @returns The registry, which has not read its settings yet.
 */
function createMcpServerRegistry(
  servers: readonly McpServerSettings[] = []
): McpServerRegistry {
  const events: McpServerEvent[] = []
  const { processGroups } = createOwnedMcpServerProcessGroups()
  const mcpSettings = mcpSettingsSchema.parse({ servers })
  const registry = new McpServerRegistry({
    readSettings: () =>
      Promise.resolve({ status: "read", settings: mcpSettings }),
    builtInServers: [],
    openServer: (settings, context) =>
      openMcpServer(settings, context, MCP_OPENING_TIMEOUT_MILLISECONDS),
    workingDirectory: process.cwd(),
    processGroups,
    reportEvent: (event) => events.push(event)
  })
  onTestFinished(async () => {
    await registry.close()
  })
  return registry
}

/**
 * Creates an MCP server registry connected to one fake HTTP server, `notes`,
 * which lists {@link FIND_NOTES_TOOL}.
 *
 * @returns The registry, once it lists the server's tool; closed when the
 * case finishes.
 */
async function createConnectedNotesRegistry(): Promise<McpServerRegistry> {
  /** Bound of the wait for the server to connect. */
  const mcpStateWait = Object.freeze({ timeout: 10_000, interval: 10 })

  const mcpServer = await startFakeMcpHttpServer(
    answerAsMcpServer([FIND_NOTES_TOOL])
  )
  const registry = createMcpServerRegistry([
    buildHttpServerSettings("notes", mcpServer.url)
  ])
  await registry.updateServers()
  await vi.waitFor(() => {
    expect(registry.listToolDefinitions()).toHaveLength(1)
  }, mcpStateWait)
  return registry
}

/**
 * Registers the tool routes, behind the backend's HTTP transport, over a web
 * search provider whose key reads give one result and whose requests would
 * reach a fake Tavily server, a read-page tool that reads through vmo, an
 * MCP server registry, and the delegation tool Settings lists.
 *
 * @param keyRead - What every key read gives.
 * @param vmoOrigin - Origin of vmo; a fake vmo that answers its health route
 * when omitted.
 * @param mcpServerRegistry - Registry of the MCP servers; one with no
 * server when omitted.
 * @returns The application, and the server that records any request sent.
 */
async function createToolRouteApp(
  keyRead: TavilyApiKeyRead,
  vmoOrigin?: string,
  mcpServerRegistry: McpServerRegistry = createMcpServerRegistry()
) {
  const server = await startTavilyServer(answerWithJson({}))
  const webSearchToolProvider = new WebSearchToolProvider(
    () => Promise.resolve(keyRead),
    server.dependencies
  )
  const { app } = createTestFastify()
  await updateFastifyWithHttpTransport(app)
  app.decorate("webSearchToolProvider", webSearchToolProvider)
  app.decorate("mcpServerRegistry", mcpServerRegistry)
  app.decorate("builtInTools", [
    ...createBuiltInTools(
      webSearchToolProvider,
      vmoOrigin ?? (await startHealthyVmo()),
      () => undefined
    ),
    {
      definition: LOOK_UP_WORD_TOOL,
      provider: new ScriptedBuiltInToolProvider({
        status: "ready",
        tool: new ScriptedBuiltInTool()
      })
    }
  ])
  app.decorate("listedAgentTools", buildListedDelegationDefinitions())
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
          LOOK_UP_WORD_TOOL,
          ...buildListedDelegationDefinitions()
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

    it("names read_page unavailable while vmo does not answer its health route", async () => {
      const { app } = await createToolRouteApp(
        { status: "configured", apiKey: TEST_TAVILY_API_KEY },
        await findClosedVmoOrigin()
      )

      const response = await app.inject({ method: "GET", url: "/api/v1/tools" })

      expect(response.json()).toMatchObject({
        unavailableTools: [
          { name: "read_page", reason: "page-reader-not-ready" }
        ]
      })
      expect(
        listBackendToolsApiResponseSchema.safeParse(response.json()).success
      ).toBe(true)
    })

    it("lists the tools of the connected MCP servers after the built-in tools, with their input schemas whole", async () => {
      const { app } = await createToolRouteApp(
        { status: "missing" },
        undefined,
        await createConnectedNotesRegistry()
      )

      const response = await app.inject({ method: "GET", url: "/api/v1/tools" })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({
        tools: [
          buildReadPageDefinition(),
          buildWebSearchDefinition(),
          LOOK_UP_WORD_TOOL,
          ...buildListedDelegationDefinitions(),
          {
            name: "mcp__notes__find_notes",
            description: "Finds notes.",
            group: "mcp",
            access: "unknown",
            runner: "mcp",
            server: "notes",
            serverToolName: "find.notes",
            inputSchema: FIND_NOTES_TOOL.inputSchema
          }
        ],
        unavailableTools: [{ name: "web_search", reason: "api-key-missing" }]
      })
      expect(
        listBackendToolsApiResponseSchema.safeParse(response.json()).success
      ).toBe(true)
    })

    it("lists delegate_work after the built-in tools and before the MCP tools, in the agents group with agents access and the backend runner", async () => {
      const { app } = await createToolRouteApp(
        { status: "missing" },
        undefined,
        await createConnectedNotesRegistry()
      )

      const response = await app.inject({ method: "GET", url: "/api/v1/tools" })

      const { tools } = listBackendToolsApiResponseSchema.parse(response.json())
      expect(tools.map((tool) => tool.name)).toEqual([
        "read_page",
        "web_search",
        LOOK_UP_WORD_TOOL.name,
        DELEGATE_WORK_TOOL_NAME,
        "mcp__notes__find_notes"
      ])
      expect(tools[3]).toMatchObject({
        name: DELEGATE_WORK_TOOL_NAME,
        group: "agents",
        access: "agents",
        runner: "backend"
      })
    })

    it("never lists delegate_work as unavailable, even while every built-in tool is", async () => {
      const { app } = await createToolRouteApp(
        { status: "missing" },
        await findClosedVmoOrigin()
      )

      const response = await app.inject({ method: "GET", url: "/api/v1/tools" })

      expect(response.json()).toMatchObject({
        unavailableTools: [
          { name: "read_page", reason: "page-reader-not-ready" },
          { name: "web_search", reason: "api-key-missing" }
        ]
      })
      expect(
        listBackendToolsApiResponseSchema.parse(response.json()).tools
      ).toContainEqual(
        expect.objectContaining({ name: DELEGATE_WORK_TOOL_NAME })
      )
    })

    it("lists neither report_progress nor stop_job", async () => {
      const { app } = await createToolRouteApp({ status: "missing" })

      const response = await app.inject({ method: "GET", url: "/api/v1/tools" })

      const names = listBackendToolsApiResponseSchema
        .parse(response.json())
        .tools.map((tool) => tool.name)
      expect(names).not.toContain(REPORT_PROGRESS_TOOL_NAME)
      expect(names).not.toContain(STOP_JOB_TOOL_NAME)
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
