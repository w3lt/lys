import {
  listMcpServersApi,
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
  | {
      /**
       * The backend returned the declared server-off problem: the server is
       * switched off, or it is a built-in server without a usable account,
       * so it cannot be opened, and nothing changed.
       */
      readonly status: "off"
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

/** HTTP status of a reconnect of a server that is off or cannot start. */
const HTTP_CONFLICT_STATUS = 409

/** HTTP status of a reconnect the backend refused with a declared problem. */
type McpReconnectProblemStatus =
  typeof HTTP_NOT_FOUND_STATUS | typeof HTTP_CONFLICT_STATUS

/** Outcome of a reconnect the backend refused with a declared problem. */
type McpReconnectRefusal = Exclude<
  ReconnectMcpServerResult,
  { readonly status: "reconnected" }
>

/** Outcome each declared problem of a reconnect stands for, by its status. */
const MCP_RECONNECT_REFUSALS = Object.freeze({
  [HTTP_NOT_FOUND_STATUS]: Object.freeze({ status: "not-found" }),
  [HTTP_CONFLICT_STATUS]: Object.freeze({ status: "off" })
} satisfies Readonly<Record<McpReconnectProblemStatus, McpReconnectRefusal>>)

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
 * @throws A caller-safe error when the backend cannot be reached, when it
 * answers with another status, naming only that status, or when its answer
 * has another media type or a list that does not match the shared schema;
 * the decoding failure is kept as its cause.
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
 * @throws A caller-safe error when the backend cannot be reached, when it
 * answers with another status, naming only that status, or when its answer
 * has another media type or a list that does not match the shared schema;
 * the decoding failure is kept as its cause. An answer with another status
 * does not show whether the backend applied the group.
 */
export async function sendMcpServerSyncRequest(
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
 * again; `not-found` when the backend reports the declared server-not-found
 * problem; `off` when it reports the declared server-off problem.
 * @throws A caller-safe error when the backend cannot be reached, when it
 * answers with another status or with a 404 or 409 without the problem its
 * status declares, naming only the status, or when its answer has another
 * media type or a list that does not match the shared schema.
 */
export async function sendMcpServerReconnectRequest(
  connection: McpApiConnection,
  serverName: McpServerName
): Promise<ReconnectMcpServerResult> {
  const response = await sendMcpRequest({
    backendUrl: connection.backendUrl,
    method: reconnectMcpServerApi.method,
    path: reconnectMcpServerApi.path.replace(":serverName", serverName),
    hasActionBody: true
  })
  if (
    response.status === HTTP_NOT_FOUND_STATUS ||
    response.status === HTTP_CONFLICT_STATUS
  ) {
    return await parseMcpReconnectProblem(response, response.status)
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
 * Creates the caller-safe failure for an undeclared response status.
 *
 * @param status - HTTP status observed on the answered request.
 * @returns An error naming only the status, never server-provided text.
 */
function createMcpResponseError(status: number): Error {
  return new Error(
    `The backend could not complete the MCP server request (HTTP ${status}).`
  )
}

/**
 * Decodes the server list of a successful response.
 *
 * @param response - Response consumed here.
 * @returns The validated, frozen list.
 * @throws A caller-safe error naming only the status when the status is not
 * the declared success status; otherwise a caller-safe error keeping the
 * cause when the media type, JSON, or schema is not the declared success
 * representation.
 */
async function parseMcpServerList(response: Response): Promise<McpServerList> {
  if (response.status !== HTTP_OK_STATUS) {
    await response.body?.cancel()
    throw createMcpResponseError(response.status)
  }
  const mediaType = response.headers.get("content-type")?.split(";")[0].trim()
  try {
    if (mediaType !== "application/json") {
      await response.body?.cancel()
      throw new Error("The MCP server list is not JSON.")
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
 * Decodes a 404 or 409 answer to a reconnect.
 *
 * @param response - Response with that status, consumed here.
 * @param status - Its HTTP status.
 * @returns `not-found` for the declared server-not-found problem with HTTP
 * 404; `off` for the declared server-off problem with HTTP 409.
 * @throws A caller-safe error naming only the status when the body is not
 * the problem its status declares, such as the answer of an unregistered
 * route, which is not evidence of what the problem says.
 */
async function parseMcpReconnectProblem(
  response: Response,
  status: McpReconnectProblemStatus
): Promise<McpReconnectRefusal> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    body = undefined
  }
  if (!reconnectMcpServerApi.responses[status].safeParse(body).success) {
    throw createMcpResponseError(status)
  }
  return MCP_RECONNECT_REFUSALS[status]
}
