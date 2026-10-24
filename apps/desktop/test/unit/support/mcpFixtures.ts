import {
  createMcpServerNotFoundProblem,
  mcpServerListSchema,
  mcpServerStateSchema,
  type McpServerFailure,
  type McpServerList,
  type McpServerNotFoundProblem,
  type McpServerState,
  type McpServerStatus,
  type SkippedMcpTool
} from "@lys/protocol"
import type { McpServerTransport } from "@lys/share"

/** State of a server the backend is starting or reaching. */
export const CONNECTING_MCP_STATE: McpServerState = mcpServerStateSchema.parse({
  status: "connecting"
})

/**
 * Builds the state of a connected server.
 *
 * @param toolCount - Tools the backend lists for the server.
 * @param skippedTools - Tools read but not listed; none by default.
 * @param isToolListCut - Whether the server has more tools than the backend
 * reads; false by default.
 * @returns A frozen state validated by the shared schema.
 */
export function buildConnectedMcpState(
  toolCount: number,
  skippedTools: readonly SkippedMcpTool[] = [],
  isToolListCut = false
): McpServerState {
  return mcpServerStateSchema.parse({
    status: "connected",
    toolCount,
    skippedTools,
    isToolListCut
  })
}

/**
 * Builds the state of a server that is not connected.
 *
 * @param reason - Why it is not connected.
 * @returns A frozen state validated by the shared schema.
 */
export function buildFailedMcpState(reason: McpServerFailure): McpServerState {
  return mcpServerStateSchema.parse({ status: "failed", reason })
}

/**
 * Builds one applied server as the backend lists it.
 *
 * @param name - Server name.
 * @param transport - How the backend talks to it.
 * @param state - Its connection state.
 * @returns The listed server; {@link buildMcpServerList} validates it.
 */
export function buildMcpServerStatus(
  name: string,
  transport: McpServerTransport,
  state: McpServerState
): McpServerStatus {
  return Object.freeze({ name, transport, state })
}

/**
 * Builds the backend's list of applied servers.
 *
 * @param servers - Applied servers in the group's order.
 * @param settings - Outcome of the backend's last read of the `mcp` group;
 * `applied` by default.
 * @returns A frozen list validated by the shared schema.
 */
export function buildMcpServerList(
  servers: readonly McpServerStatus[],
  settings: McpServerList["settings"] = "applied"
): McpServerList {
  return mcpServerListSchema.parse({ settings, servers })
}

/**
 * Builds the problem the backend answers a reconnect of a server it has not
 * applied with.
 *
 * @param serverName - Server the request names.
 * @returns The declared HTTP 404 problem.
 */
export function buildMcpServerNotFoundProblem(
  serverName: string
): McpServerNotFoundProblem {
  return createMcpServerNotFoundProblem(
    serverName,
    `/api/v1/mcp/servers/${serverName}/reconnect`
  )
}
