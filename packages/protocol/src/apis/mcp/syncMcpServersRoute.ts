import {
  mcpServerActionBodySchema,
  mcpServerListSchema,
  type McpServerActionBody,
  type McpServerList
} from "./_share"
import { apiMcpServersSyncRoute } from "./routes"

/** Selects the sync response validator by HTTP status. */
const syncMcpServersApiResponseSchemas = Object.freeze({
  200: mcpServerListSchema
})

/**
 * Describes the POST endpoint that reads the `mcp` settings group again and
 * applies it.
 *
 * @remarks A server whose settings did not change keeps its connection and
 * state; a changed one is closed and opened again; a removed one is closed;
 * a new one is opened. When the group cannot be read or fails its rules,
 * the applied servers stay as they are. The answer is the list as the
 * server-list endpoint returns it right after applying, so opened servers
 * are `connecting`; it does not wait for them. Syncs apply one at a time in
 * the order they arrive. It is a POST with a required JSON body: see
 * `mcpServerActionBodySchema`. Changing the method, path, or schemas
 * changes the transmitted compatibility contract and requires coordinated
 * consumers.
 */
export const syncMcpServersApi = Object.freeze({
  method: "POST",
  path: apiMcpServersSyncRoute,
  body: mcpServerActionBodySchema,
  responses: syncMcpServersApiResponseSchemas
})

/** Status-specific payloads returned by the sync endpoint. */
export type SyncMcpServersApiReply = {
  /** Applied servers and their states right after applying. */
  readonly 200: McpServerList
}

/** Fastify route type for the sync endpoint. */
export type SyncMcpServersApiRoute = {
  /** Validated empty body. */
  readonly Body: McpServerActionBody
  /** Status-specific sync payload. */
  readonly Reply: SyncMcpServersApiReply
}
