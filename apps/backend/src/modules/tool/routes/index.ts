import {
  checkWebSearchKeyApi,
  listBackendToolsApi,
  type CheckWebSearchKeyApiRoute,
  type ListBackendToolsApiResponse,
  type ListBackendToolsApiRoute,
  type UnavailableBackendTool
} from "@lys/protocol"
import type { FastifyInstance } from "fastify"
import * as z from "zod"
import type {
  BuiltInToolEntry,
  BuiltInToolPreparation
} from "../builtIn/builtInTool"

/**
 * Registers the endpoints that list the tools the backend runs and check the
 * web search tool's saved key.
 *
 * @param app - Application whose singleton services hold the built-in tools
 * and the web search tool provider.
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
 * Registers the endpoint that lists the built-in tools.
 *
 * @param app - Application whose singleton services hold the built-in tools.
 * @throws If Fastify cannot register the route.
 * @remarks The definitions are fixed for the backend's lifetime; each request
 * prepares every tool again to report which cannot run now.
 */
function registerListBackendToolsRoute(app: FastifyInstance): void {
  const entries = app.builtInTools
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
    handler: () => buildBackendToolList(entries)
  })
}

/**
 * Registers the endpoint that checks the saved Tavily key.
 *
 * @param app - Application whose singleton services hold the web search tool
 * provider.
 * @throws If Fastify cannot register the route.
 */
function registerCheckWebSearchKeyRoute(app: FastifyInstance): void {
  const provider = app.webSearchToolProvider
  app.route<CheckWebSearchKeyApiRoute>({
    method: checkWebSearchKeyApi.method,
    url: checkWebSearchKeyApi.path,
    schema: {
      response: {
        200: z.toJSONSchema(checkWebSearchKeyApi.responses[200], {
          target: "draft-7"
        })
      }
    },
    handler: () => provider.checkApiKey()
  })
}

/**
 * Builds the tool list with every tool's availability now.
 *
 * @param entries - Every built-in tool, in Settings order.
 * @returns Every definition in order, and each tool that cannot run now with
 * why, in the same order.
 * @throws A provider's defect.
 */
async function buildBackendToolList(
  entries: readonly BuiltInToolEntry[]
): Promise<ListBackendToolsApiResponse> {
  const preparations = await Promise.all(
    entries.map((entry) => entry.provider.prepareTool())
  )
  const unavailableTools = entries.flatMap((entry, index) =>
    findUnavailableTool(entry, preparations[index])
  )
  const tools = Object.freeze(entries.map((entry) => entry.definition))
  return Object.freeze({
    tools,
    unavailableTools: Object.freeze(unavailableTools)
  })
}

/**
 * Finds whether one tool cannot run now.
 *
 * @param entry - Built-in tool.
 * @param preparation - Its preparation now.
 * @returns The tool's name and why it cannot run, or nothing when it is
 * ready.
 * @throws When the preparation is missing, which `Promise.all` rules out.
 */
function findUnavailableTool(
  entry: BuiltInToolEntry,
  preparation: BuiltInToolPreparation | undefined
): readonly UnavailableBackendTool[] {
  if (preparation === undefined)
    throw new Error("A tool preparation is missing")
  if (preparation.status === "ready") return []
  return [
    Object.freeze({ name: entry.definition.name, reason: preparation.reason })
  ]
}
