import * as z from "zod"

/** Stable problem category for a request naming no applied MCP server. */
const MCP_SERVER_NOT_FOUND_PROBLEM_TYPE = "urn:lys:problem:mcp:server-not-found"

/** Client-facing summary shared by every missing-server occurrence. */
const MCP_SERVER_NOT_FOUND_PROBLEM_TITLE = "MCP server not found"

/** HTTP status accompanying a missing-server problem body. */
const MCP_SERVER_NOT_FOUND_PROBLEM_STATUS = 404

/**
 * Validates the RFC 9457 body returned when a request names an MCP server
 * the backend has not applied.
 *
 * @remarks The reconnect endpoint transmits this contract with HTTP 404 and
 * changes nothing. The `type` literal is the machine-readable
 * discriminator; `detail` is caller-safe text. A 404 response without this
 * body, such as an unregistered route, is not evidence that a server is
 * absent. Changing any fixed field requires coordinated consumers.
 */
export const mcpServerNotFoundProblemSchema = z
  .strictObject({
    /** Stable discriminator separating a missing server from other failures. */
    type: z.literal(MCP_SERVER_NOT_FOUND_PROBLEM_TYPE),
    /** Human-readable category summary shared across occurrences. */
    title: z.literal(MCP_SERVER_NOT_FOUND_PROBLEM_TITLE),
    /** HTTP status accompanying this problem body. */
    status: z.literal(MCP_SERVER_NOT_FOUND_PROBLEM_STATUS),
    /** Caller-safe explanation of this occurrence. */
    detail: z.string().min(1),
    /** Optional identifier of this problem occurrence. */
    instance: z.string().min(1).optional()
  })
  .readonly()

/** Missing-server Problem Details body inferred from its schema. */
export type McpServerNotFoundProblem = z.infer<
  typeof mcpServerNotFoundProblemSchema
>

/**
 * Builds the problem for a request naming an MCP server the backend has not
 * applied.
 *
 * @param serverName - Validated name the request names.
 * @param instance - Request path identifying this occurrence.
 * @returns A frozen problem body for HTTP 404.
 */
export function createMcpServerNotFoundProblem(
  serverName: string,
  instance: string
): McpServerNotFoundProblem {
  return Object.freeze({
    type: MCP_SERVER_NOT_FOUND_PROBLEM_TYPE,
    title: MCP_SERVER_NOT_FOUND_PROBLEM_TITLE,
    status: MCP_SERVER_NOT_FOUND_PROBLEM_STATUS,
    detail: `No MCP server named ${serverName} is applied.`,
    instance
  })
}
