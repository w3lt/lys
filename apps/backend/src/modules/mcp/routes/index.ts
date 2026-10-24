import {
  createMcpServerNotFoundProblem,
  listMcpServersApi,
  reconnectMcpServerApi,
  syncMcpServersApi,
  type ListMcpServersApiRoute,
  type ReconnectMcpServerApiRoute,
  type SyncMcpServersApiRoute
} from "@lys/protocol"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { serializerCompiler } from "fastify-type-provider-zod"
import type McpServerRegistry from "../mcpServerRegistry"

/**
 * Registers the endpoints that list the MCP servers, apply the settings
 * again, and reconnect one server.
 *
 * @param app - Application whose singleton services hold the MCP server
 * registry, with the zod validator compiler installed.
 * @returns A promise that resolves after route registration completes.
 * @throws If Fastify cannot register a route. The failure rejects the
 * promise, so `app.register` reports it rather than an uncaught exception.
 * @remarks Fastify answers a sync or reconnect request whose body is not
 * the empty JSON object the protocol requires with HTTP 400, or 415 for a
 * media type it cannot parse, and a malformed server name with HTTP 400,
 * before the handler runs.
 */
export default function registerMcpRoutes(app: FastifyInstance): Promise<void> {
  return new Promise((resolve) => {
    app.setSerializerCompiler(serializerCompiler)
    registerMcpServerListRoutes(app, app.mcpServerRegistry)
    registerReconnectMcpServerRoute(app, app.mcpServerRegistry)
    resolve()
  })
}

/**
 * Registers the endpoints that answer with the server list: the read and
 * the sync.
 *
 * @param app - Application to register the routes on.
 * @param registry - Borrowed MCP server registry.
 */
function registerMcpServerListRoutes(
  app: FastifyInstance,
  registry: McpServerRegistry
): void {
  registerListMcpServersRoute(app, registry)
  registerSyncMcpServersRoute(app, registry)
}

/**
 * Registers the endpoint that lists the applied servers and their states.
 *
 * @param app - Application to register the route on.
 * @param registry - Borrowed MCP server registry.
 */
function registerListMcpServersRoute(
  app: FastifyInstance,
  registry: McpServerRegistry
): void {
  app.route<ListMcpServersApiRoute>({
    method: listMcpServersApi.method,
    url: listMcpServersApi.path,
    schema: { response: listMcpServersApi.responses },
    handler: () => registry.listServers()
  })
}

/**
 * Registers the endpoint that reads the `mcp` settings group again, applies
 * it, and sends the server list.
 *
 * @param app - Application to register the route on.
 * @param registry - Borrowed MCP server registry.
 */
function registerSyncMcpServersRoute(
  app: FastifyInstance,
  registry: McpServerRegistry
): void {
  app.route<SyncMcpServersApiRoute>({
    method: syncMcpServersApi.method,
    url: syncMcpServersApi.path,
    schema: {
      body: syncMcpServersApi.body,
      response: syncMcpServersApi.responses
    },
    handler: async () => {
      await registry.applySettings()
      return registry.listServers()
    }
  })
}

/**
 * Registers the endpoint that opens one applied server again.
 *
 * @param app - Application to register the route on.
 * @param registry - Borrowed MCP server registry.
 */
function registerReconnectMcpServerRoute(
  app: FastifyInstance,
  registry: McpServerRegistry
): void {
  app.route<ReconnectMcpServerApiRoute>({
    method: reconnectMcpServerApi.method,
    url: reconnectMcpServerApi.path,
    schema: {
      params: reconnectMcpServerApi.params,
      body: reconnectMcpServerApi.body,
      response: reconnectMcpServerApi.responses
    },
    handler: (request, reply) => {
      handleReconnect(request, reply, registry)
    }
  })
}

/**
 * Opens one applied server again and sends the server list, or sends the
 * server-not-found problem.
 *
 * @param request - Validated server name.
 * @param reply - HTTP response owner.
 * @param registry - Borrowed MCP server registry.
 */
function handleReconnect(
  request: FastifyRequest<ReconnectMcpServerApiRoute>,
  reply: FastifyReply<ReconnectMcpServerApiRoute>,
  registry: McpServerRegistry
): void {
  const { serverName } = request.params
  if (registry.reconnect(serverName) === "not-found") {
    reply
      .type("application/problem+json")
      .code(404)
      .send(createMcpServerNotFoundProblem(serverName, request.url))
    return
  }
  reply.code(200).send(registry.listServers())
}
