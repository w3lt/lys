import {
  checkWebSearchKeyApi,
  listBackendToolsApi,
  type CheckWebSearchKeyApiRoute,
  type ListBackendToolsApiResponse,
  type ListBackendToolsApiRoute,
  type UnavailableBackendTool
} from "@lys/protocol"
import type { McpToolDefinition } from "@lys/share"
import type { FastifyInstance } from "fastify"
import * as z from "zod"
import type { BuiltInToolEntry, TurnToolLookup } from "../builtIn/builtInTool"

/**
 * Registers the endpoints that list the tools the backend runs and check the
 * web search tool's saved key.
 *
 * @param app - Application whose singleton services hold the built-in tools,
 * the web search tool provider, and the MCP server registry, with the zod
 * validator compiler installed.
 * @returns A promise that resolves after route registration completes.
 * @throws If Fastify cannot register a route. The failure rejects the
 * promise, so `app.register` reports it rather than an uncaught exception.
 */
export default function registerToolRoutes(
  app: FastifyInstance
): Promise<void> {
  return new Promise((resolve) => {
    registerListBackendToolsRoute(app)
    registerCheckWebSearchKeyRoute(app)
    resolve()
  })
}

/**
 * Registers the endpoint that lists the built-in tools and the tools of the
 * connected MCP servers.
 *
 * @param app - Application whose singleton services hold the built-in tools
 * and the MCP server registry.
 * @throws If Fastify cannot register the route.
 * @remarks The built-in definitions are fixed for the backend's lifetime;
 * each request looks up every built-in tool again to report which cannot
 * run now, and lists the MCP tools of the servers connected at that moment.
 */
function registerListBackendToolsRoute(app: FastifyInstance): void {
  const entries = app.builtInTools
  const registry = app.mcpServerRegistry
  app.route<ListBackendToolsApiRoute>({
    method: listBackendToolsApi.method,
    url: listBackendToolsApi.path,
    schema: {
      response: {
        200: z.toJSONSchema(listBackendToolsApi.responses[200], {
          target: "draft-7"
        })
      }
    },
    handler: () => buildBackendToolList(entries, registry.listToolDefinitions())
  })
}

/**
 * Registers the endpoint that checks the saved Tavily key.
 *
 * @param app - Application whose singleton services hold the web search tool
 * provider, with the zod validator compiler installed.
 * @throws If Fastify cannot register the route.
 * @remarks Fastify answers a request whose body is not the empty JSON object
 * the protocol requires with HTTP 400, or 415 for a media type it cannot
 * parse, before the handler reads the key.
 */
function registerCheckWebSearchKeyRoute(app: FastifyInstance): void {
  const provider = app.webSearchToolProvider
  app.route<CheckWebSearchKeyApiRoute>({
    method: checkWebSearchKeyApi.method,
    url: checkWebSearchKeyApi.path,
    schema: {
      body: checkWebSearchKeyApi.body,
      response: {
        200: z.toJSONSchema(checkWebSearchKeyApi.responses[200], {
          target: "draft-7"
        })
      }
    },
    handler: () => provider.sendApiKeyCheck()
  })
}

/**
 * Builds the tool list with every tool's availability now.
 *
 * @param entries - Every built-in tool, in Settings order.
 * @param mcpTools - Tools of the connected MCP servers, in settings order;
 * each can run.
 * @returns Every built-in definition in order, then the MCP tools, and each
 * built-in tool that cannot run now with why, in the same order.
 * @throws A provider's defect.
 */
async function buildBackendToolList(
  entries: readonly BuiltInToolEntry[],
  mcpTools: readonly McpToolDefinition[]
): Promise<ListBackendToolsApiResponse> {
  const lookups = await Promise.all(
    entries.map((entry) => entry.provider.findTurnTool())
  )
  const unavailableTools = entries.flatMap((entry, index) =>
    findUnavailableTool(entry, lookups[index])
  )
  const tools = Object.freeze([
    ...entries.map((entry) => entry.definition),
    ...mcpTools
  ])
  return Object.freeze({
    tools,
    unavailableTools: Object.freeze(unavailableTools)
  })
}

/**
 * Finds whether one tool cannot run now.
 *
 * @param entry - Built-in tool.
 * @param lookup - Its lookup now.
 * @returns The tool's name and why it cannot run, or nothing when it is
 * ready.
 * @throws When the lookup is missing, which `Promise.all` rules out.
 */
function findUnavailableTool(
  entry: BuiltInToolEntry,
  lookup: TurnToolLookup | undefined
): readonly UnavailableBackendTool[] {
  if (lookup === undefined) throw new Error("A tool lookup is missing")
  if (lookup.status === "ready") return []
  return [Object.freeze({ name: entry.definition.name, reason: lookup.reason })]
}
