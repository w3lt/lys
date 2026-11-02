import {
  checkEmailAccountApi,
  createMcpServerNotFoundProblem,
  createMcpServerOffProblem,
  listMcpServersApi,
  reconnectMcpServerApi,
  syncMcpServersApi,
  type CheckEmailAccountApiRoute,
  type ListMcpServersApiRoute,
  type ReconnectMcpServerApiRoute,
  type SyncMcpServersApiRoute
} from "@lys/protocol"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { serializerCompiler } from "fastify-type-provider-zod"
import type EmailAccountChecker from "../builtIn/email/emailAccountCheck"
import type McpServerRegistry from "../mcpServerRegistry"

/**
 * Registers the endpoints that list the MCP servers, apply the settings
 * again, reconnect one server, and check an email account for the built-in
 * email server.
 *
 * @param app - Application whose singleton services hold the MCP server
 * registry and the email account checker, with the zod validator compiler
 * installed.
 * @returns A promise that resolves after route registration completes.
 * @throws If Fastify cannot register a route. The failure rejects the
 * promise, so `app.register` reports it rather than an uncaught exception.
 * @remarks Fastify answers a sync or reconnect request whose body is not
 * the empty JSON object the protocol requires, or an account-check request
 * whose body fails the account or password rules, with HTTP 400, or 415
 * for a media type it cannot parse, and a malformed server name with HTTP
 * 400, before the handler runs.
 */
export default function registerMcpRoutes(app: FastifyInstance): Promise<void> {
  return new Promise((resolve) => {
    app.setSerializerCompiler(serializerCompiler)
    registerMcpServerListRoutes(app, app.mcpServerRegistry)
    registerReconnectMcpServerRoute(app, app.mcpServerRegistry)
    registerCheckEmailAccountRoute(app, app.emailAccountChecker)
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
      await registry.updateServers()
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
 * server-not-found or server-off problem.
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
  switch (registry.openServerAgain(serverName)) {
    case "not-found":
      reply
        .type("application/problem+json")
        .code(404)
        .send(createMcpServerNotFoundProblem(serverName, request.url))
      return
    case "off":
      reply
        .type("application/problem+json")
        .code(409)
        .send(createMcpServerOffProblem(serverName, request.url))
      return
    case "reconnecting":
      reply.code(200).send(registry.listServers())
      return
  }
}

/**
 * Registers the endpoint that signs in to an email account's servers
 * through the email server Lys ships and answers with the outcome.
 *
 * @param app - Application to register the route on.
 * @param checker - Borrowed email account checker.
 */
function registerCheckEmailAccountRoute(
  app: FastifyInstance,
  checker: EmailAccountChecker
): void {
  app.route<CheckEmailAccountApiRoute>({
    method: checkEmailAccountApi.method,
    url: checkEmailAccountApi.path,
    schema: {
      body: checkEmailAccountApi.body,
      response: checkEmailAccountApi.responses
    },
    handler: (request) =>
      checker.sendCheck(request.body.account, request.body.password)
  })
}
