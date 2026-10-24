import type { McpServerFailure } from "@lys/protocol"
import type { McpServerSettings } from "@lys/share"
import { classifyMcpRequestFailure, type McpRequestFailure } from "./mcpError"
import McpServerConnection, {
  type McpServerConnectionContext
} from "./mcpServerConnection"
import { buildMcpToolCatalog, type McpToolCatalog } from "./mcpToolCatalog"

/** What opening one server led to. */
export type McpServerOpening =
  | Readonly<{
      /** The server is connected and its tools are read. */
      status: "connected"
      /** The open connection; the caller owns it and must close it. */
      connection: McpServerConnection
      /** The tools the backend lists for it. */
      catalog: McpToolCatalog
    }>
  | Readonly<{
      /** The server could not be opened; nothing it started is left open. */
      status: "failed"
      /** Why, as the server list reports it. */
      reason: McpServerFailure
      /** What the failure was, for the log. */
      failure: McpRequestFailure
      /** What was thrown, kept only when Lys could not tell what it was. */
      unknownError: unknown
    }>
  | Readonly<{
      /** The caller cancelled the opening; nothing it started is left open. */
      status: "cancelled"
    }>

/** Opening of a cancelled attempt. */
const CANCELLED_OPENING: McpServerOpening = Object.freeze({
  status: "cancelled"
})

/**
 * Opens one server and reads its tools.
 *
 * @param settings - Validated settings of the server.
 * @param context - Working folder, cancellation, and the reporters of the
 * connection's later events; borrowed. The opening runs under the context's
 * signal.
 * @param timeoutMilliseconds - Longest the whole opening may take, such as
 * `MCP_SERVER_OPENING_TIMEOUT_MILLISECONDS`; at most that, because each of
 * its requests has that limit too.
 * @returns `connected` with the connection and its catalog; `failed` with
 * the reason; or `cancelled` once the context's signal aborted. A failure
 * Lys cannot tell apart is `protocol-error`, with what was thrown.
 * @throws Only when closing what it started fails, which the SDK's
 * transports do not do.
 * @remarks Whatever the opening started is closed before it returns
 * anything but `connected`.
 */
export async function openMcpServer(
  settings: McpServerSettings,
  context: McpServerConnectionContext,
  timeoutMilliseconds: number
): Promise<McpServerOpening> {
  const timeoutSignal = AbortSignal.timeout(timeoutMilliseconds)
  const abortSignal = AbortSignal.any([context.abortSignal, timeoutSignal])
  let connection: McpServerConnection | undefined
  try {
    connection = await McpServerConnection.open(settings, {
      ...context,
      abortSignal
    })
    const tools = await connection.listTools(abortSignal)
    return Object.freeze({
      status: "connected",
      connection,
      catalog: buildMcpToolCatalog(settings.name, tools)
    })
  } catch (error) {
    await connection?.close()
    if (context.abortSignal.aborted) return CANCELLED_OPENING
    if (timeoutSignal.aborted)
      return buildFailedOpening({ kind: "timed-out" }, undefined)
    const failure = classifyMcpRequestFailure(error)
    return buildFailedOpening(
      failure,
      failure.kind === "unknown" ? error : undefined
    )
  }
}

/**
 * Builds the outcome of a failed opening.
 *
 * @param failure - What the failure was.
 * @param unknownError - What was thrown when Lys could not tell what it
 * was; otherwise undefined.
 * @returns A frozen `failed` outcome with the reason the server list
 * reports.
 */
function buildFailedOpening(
  failure: McpRequestFailure,
  unknownError: unknown
): McpServerOpening {
  return Object.freeze({
    status: "failed",
    reason: findOpeningFailureReason(failure),
    failure,
    unknownError
  })
}

/**
 * Finds the reason the server list reports for a failed opening.
 *
 * @param failure - What the failure was.
 * @returns `unauthorized` for HTTP 401 and 403, `http-error` for every other
 * HTTP status, `protocol-error` for an error answer, an answer that is not
 * MCP or is too large, or a failure Lys cannot tell apart, and the failure's
 * own kind otherwise.
 */
function findOpeningFailureReason(
  failure: McpRequestFailure
): McpServerFailure {
  switch (failure.kind) {
    case "timed-out":
    case "closed":
    case "unreachable":
    case "start-failed":
      return failure.kind
    case "http-status":
      return findHttpFailureReason(failure.status)
    case "refused":
    case "invalid-answer":
    case "too-large":
    case "unknown":
      return "protocol-error"
  }
}

/**
 * Finds the reason the server list reports for an opening the server
 * answered with an HTTP error status.
 *
 * @param status - HTTP status the server answered with.
 * @returns `unauthorized` for 401 and 403, `http-error` otherwise.
 */
function findHttpFailureReason(status: number): McpServerFailure {
  return status === 401 || status === 403 ? "unauthorized" : "http-error"
}
