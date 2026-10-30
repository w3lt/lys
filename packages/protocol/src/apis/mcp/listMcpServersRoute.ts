import { mcpServerListSchema, type McpServerList } from "./_share"
import { apiMcpServersRoute } from "./routes"

/** Selects the server-list response validator by HTTP status. */
const listMcpServersApiResponseSchemas = Object.freeze({
  200: mcpServerListSchema
})

/**
 * Describes the GET endpoint that lists the MCP servers the backend applied,
 * with each one's connection state.
 *
 * @remarks The endpoint reads what the backend holds: it never reads the
 * settings file and never starts or reaches a server. Its answer carries no
 * command, URL, environment variable, or header. Changing the method, path,
 * or response schema changes the transmitted compatibility contract and
 * requires coordinated consumers.
 */
export const listMcpServersApi = Object.freeze({
  method: "GET",
  path: apiMcpServersRoute,
  responses: listMcpServersApiResponseSchemas
})

/** Status-specific payloads returned by the server-list endpoint. */
export type ListMcpServersApiReply = {
  /** Applied servers and their states. */
  readonly 200: McpServerList
}

/** Fastify route type for the server-list endpoint. */
export type ListMcpServersApiRoute = {
  /** Status-specific server-list payload. */
  readonly Reply: ListMcpServersApiReply
}

/** Response body of the server-list endpoint. */
export type ListMcpServersApiResponse = McpServerList
