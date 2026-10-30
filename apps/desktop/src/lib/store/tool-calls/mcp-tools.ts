import type { McpServerName, McpToolDefinition } from "@lys/share"

/** Validated input of one call to a tool of an MCP server. */
export type McpToolInput = {
  /** The backend sends the call to the tool's MCP server once it is allowed. */
  readonly runner: "mcp"
  /** Name the model called the tool by. */
  readonly toolName: string
  /** Name of the server that runs the tool. */
  readonly server: McpServerName
  /** Name the server calls the tool by. */
  readonly serverToolName: string
}

/** Outcome of reading one MCP call's tool from its definition. */
export type McpToolInputResult = {
  /** The person can be shown what the call does. */
  readonly status: "parsed"
  /** Validated input. */
  readonly input: McpToolInput
}

/**
 * Reads the input of one call to an MCP tool.
 *
 * @param definition - Listed definition of the called tool.
 * @returns `parsed` with the tool's server and the name the server calls it
 * by.
 * @remarks An MCP call is always shown: the backend checked that its
 * arguments are a JSON object whose keys follow the argument-name rule, and
 * the card shows every argument as it is, so the desktop never refuses to
 * describe one. Only the server checks the arguments against its schema.
 */
export function parseMcpToolInput(
  definition: McpToolDefinition
): McpToolInputResult {
  const input: McpToolInput = Object.freeze({
    runner: "mcp",
    toolName: definition.name,
    server: definition.server,
    serverToolName: definition.serverToolName
  })
  return Object.freeze({ status: "parsed", input })
}
