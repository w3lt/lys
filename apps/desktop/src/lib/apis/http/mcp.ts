import {
  listMcpServersApi,
  mcpServerNotFoundProblemSchema,
  reconnectMcpServerApi,
  syncMcpServersApi,
  type McpServerActionBody,
  type McpServerList
} from "@lys/protocol"
import type { McpServerName } from "@lys/share"

/** Transport scope sampled once for one MCP server request. */
export type McpApiConnection = {
  /** Application-owned backend origin without a trailing slash. */
  readonly backendUrl: string
}

/** Outcome of asking the backend to reconnect one MCP server. */
export type ReconnectMcpServerResult =
  | {
      /** The backend closed the server's connection and opened it again. */
      readonly status: "reconnected"
      /** Applied servers and their states right after reopening the server. */
      readonly list: McpServerList
    }
  | {
      /**
       * The backend returned the declared server-not-found problem: it has
       * not applied a server with that name, and changed nothing.
       */
      readonly status: "not-found"
    }

/** One MCP server request before it is sent. */
type McpHttpRequest = {
  /** Application-owned backend origin without a trailing slash. */
  readonly backendUrl: string
  /** HTTP method of the endpoint. */
  readonly method: string
  /** Route with any path parameter applied. */
  readonly path: string
  /** Whether the request carries the empty JSON body the actions require. */
  readonly hasActionBody: boolean
}

/** HTTP status of a successful list, sync, or reconnect. */
const HTTP_OK_STATUS = 200

/** HTTP status of a reconnect naming a server the backend has not applied. */
const HTTP_NOT_FOUND_STATUS = 404

/**
 * Body of every sync and reconnect: the empty JSON object the protocol
 * requires.
 */
const MCP_SERVER_ACTION_BODY: McpServerActionBody = Object.freeze({})

/**
 * Lists the MCP servers the backend applied, with each one's state.
 *
 * @param connection - Backend origin. The read cannot be cancelled; the MCP
 * server store owns it.
 * @returns The validated, frozen list once the backend answers. It never
 * holds a command, URL, environment value, or header.
 * @throws A caller-safe error when the backend cannot be reached, answers
 * with another status or media type, or returns a list that does not match
 * the shared schema; the decoding failure is kept as its cause.
 */
export async function listMcpServers(
  connection: McpApiConnection
): Promise<McpServerList> {
  const response = await sendMcpRequest({
    backendUrl: connection.backendUrl,
    method: listMcpServersApi.method,
    path: listMcpServersApi.path,
    hasActionBody: false
  })
  return await parseMcpServerList(response)
}

/**
 * Asks the backend to read the `mcp` settings group again and apply it.
 *
 * @param connection - Backend origin. The request cannot be cancelled; the
 * backend applies the group once it accepted the request.
 * @returns The validated list right after the backend applied the group:
 * new and changed servers are `connecting`.
 * @throws A caller-safe error when the backend cannot be reached, answers
 * with another status or media type, or returns a list that does not match
 * the shared schema; the decoding failure is kept as its cause.
 */
export async function syncMcpServers(
  connection: McpApiConnection
): Promise<McpServerList> {
  const response = await sendMcpRequest({
    backendUrl: connection.backendUrl,
    method: syncMcpServersApi.method,
    path: syncMcpServersApi.path,
    hasActionBody: true
  })
  return await parseMcpServerList(response)
}

/**
 * Asks the backend to close one MCP server's connection and open it again.
 *
 * @param connection - Backend origin. The request cannot be cancelled.
 * @param serverName - Validated name of the server; a valid name needs no
 * percent-encoding, so it is substituted as it is.
 * @returns `reconnected` with the list right after the server was opened
 * again, or `not-found` when the backend reports the declared
 * server-not-found problem.
 * @throws A caller-safe error when the backend cannot be reached or answers
 * with another status, a 404 without the declared problem, another media
 * type, or a list that does not match the shared schema.
 */
export async function reconnectMcpServer(
  connection: McpApiConnection,
  serverName: McpServerName
): Promise<ReconnectMcpServerResult> {
  const response = await sendMcpRequest({
    backendUrl: connection.backendUrl,
    method: reconnectMcpServerApi.method,
    path: reconnectMcpServerApi.path.replace(":serverName", serverName),
    hasActionBody: true
  })
  if (response.status === HTTP_NOT_FOUND_STATUS) {
    return await parseMcpServerNotFound(response)
  }
  const list = await parseMcpServerList(response)
  return Object.freeze({ status: "reconnected", list })
}

/**
 * Sends one MCP server request and returns its response, in any HTTP status.
 *
 * @param request - Endpoint, origin, and whether an action body is sent.
 * @returns The response whose body remains owned by the caller.
 * @throws A caller-safe error retaining the transport failure as its cause.
 */
async function sendMcpRequest(request: McpHttpRequest): Promise<Response> {
  // A bodyless request declares no content type; Fastify rejects empty JSON.
  const headers: Readonly<Record<string, string>> = request.hasActionBody
    ? { Accept: "application/json", "Content-Type": "application/json" }
    : { Accept: "application/json" }
  try {
    return await fetch(`${request.backendUrl}${request.path}`, {
      method: request.method,
      headers,
      body: request.hasActionBody
        ? JSON.stringify(MCP_SERVER_ACTION_BODY)
        : undefined,
      cache: "no-store"
    })
  } catch (cause) {
    throw new Error("The backend could not be reached.", { cause })
  }
}

/**
 * Decodes the server list of a successful response.
 *
 * @param response - Response consumed here.
 * @returns The validated, frozen list.
 * @throws A caller-safe error when the status, media type, JSON, or schema
 * is not the declared success representation; the cause is kept.
 */
async function parseMcpServerList(response: Response): Promise<McpServerList> {
  const mediaType = response.headers.get("content-type")?.split(";")[0].trim()
  try {
    if (
      response.status !== HTTP_OK_STATUS ||
      mediaType !== "application/json"
    ) {
      await response.body?.cancel()
      throw new Error(
        `Unexpected MCP server list response (HTTP ${response.status}).`
      )
    }
    const payload: unknown = await response.json()
    return listMcpServersApi.responses[HTTP_OK_STATUS].parse(payload)
  } catch (cause) {
    throw new Error("The backend returned an invalid MCP server list.", {
      cause
    })
  }
}

/**
 * Decodes a 404 answer to a reconnect.
 *
 * @param response - Response with HTTP 404, consumed here.
 * @returns The not-found outcome for the declared server-not-found problem.
 * @throws A caller-safe error naming the status when the body is not that
 * problem, such as the answer of an unregistered route, which is not
 * evidence that the server is absent.
 */
async function parseMcpServerNotFound(
  response: Response
): Promise<ReconnectMcpServerResult> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    body = undefined
  }
  if (!mcpServerNotFoundProblemSchema.safeParse(body).success) {
    throw new Error(
      `The backend could not reconnect the MCP server (HTTP ${response.status}).`
    )
  }
  return Object.freeze({ status: "not-found" })
}
