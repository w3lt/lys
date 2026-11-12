import {
  mcpServerNotFoundProblemSchema,
  mcpServerOffProblemSchema,
  type McpServerNotFoundProblem,
  type McpServerOffProblem
} from "../../http/errors/mcp"
import {
  mcpServerActionBodySchema,
  mcpServerListSchema,
  mcpServerPathParamsSchema,
  type McpServerActionBody,
  type McpServerList,
  type McpServerPathParams
} from "./_share"
import { apiMcpServerReconnectRoute } from "./routes"

/** Selects the reconnect response validator by HTTP status. */
const reconnectMcpServerApiResponseSchemas = Object.freeze({
  200: mcpServerListSchema,
  404: mcpServerNotFoundProblemSchema,
  409: mcpServerOffProblemSchema
})

/**
 * Describes the POST endpoint that closes one applied MCP server's
 * connection and opens it again with its applied settings.
 *
 * @remarks It does not read the settings file. The answer is the server
 * list right after the server was opened again, so it is `connecting`; it
 * does not wait for it. A name the backend has not applied returns the
 * server-not-found problem with HTTP 404 and changes nothing; a server that
 * is switched off, or a built-in server without a usable account, returns
 * the server-off problem with HTTP 409 and changes nothing. It is a POST
 * with a required JSON body: see `mcpServerActionBodySchema`. Changing the
 * method, path, or schemas changes the transmitted compatibility contract
 * and requires coordinated consumers.
 */
export const reconnectMcpServerApi = Object.freeze({
  method: "POST",
  path: apiMcpServerReconnectRoute,
  params: mcpServerPathParamsSchema,
  body: mcpServerActionBodySchema,
  responses: reconnectMcpServerApiResponseSchemas
})

/** Status-specific payloads returned by the reconnect endpoint. */
export type ReconnectMcpServerApiReply = {
  /** Applied servers and their states right after reopening the server. */
  readonly 200: McpServerList
  /** No applied server has the addressed name. */
  readonly 404: McpServerNotFoundProblem
  /** The server is switched off or has no usable account, so it cannot be opened. */
  readonly 409: McpServerOffProblem
}

/** Fastify route type for the reconnect endpoint. */
export type ReconnectMcpServerApiRoute = {
  /** Validated name of the server to reopen. */
  readonly Params: McpServerPathParams
  /** Validated empty body. */
  readonly Body: McpServerActionBody
  /** Status-specific reconnect payload. */
  readonly Reply: ReconnectMcpServerApiReply
}
