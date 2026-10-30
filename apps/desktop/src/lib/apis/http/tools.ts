import {
  checkWebSearchKeyApi,
  listBackendToolsApi,
  type ListedBackendToolUnavailableReason,
  type CheckWebSearchKeyApiRequestBody,
  type CheckWebSearchKeyApiResponse
} from "@lys/protocol"
import type { ToolDefinition } from "@lys/share"

/** Transport scope sampled once for one tool request. */
export type ToolApiConnection = {
  /** Application-owned backend origin without a trailing slash. */
  readonly backendUrl: string
}

/** Every tool the backend runs and which of them cannot run now. */
export type BackendToolList = {
  /**
   * Definitions in the order Settings shows them: the backend's own tools,
   * whose runner is `backend`, then the tools of its connected MCP servers,
   * whose runner is `mcp`.
   */
  readonly tools: readonly ToolDefinition[]
  /** Why each listed tool that cannot run now cannot, keyed by tool name. */
  readonly unavailableTools: ReadonlyMap<
    string,
    ListedBackendToolUnavailableReason
  >
}

/** HTTP status of a successful list or key check. */
const HTTP_OK_STATUS = 200

/** Body of every key check: the empty JSON object the protocol requires. */
const KEY_CHECK_REQUEST_BODY: CheckWebSearchKeyApiRequestBody = Object.freeze(
  {}
)

/**
 * Lists every tool the backend runs, in the order Settings shows them.
 *
 * @param connection - Backend origin. The read cannot be cancelled; the
 * tool store owns it.
 * @returns A promise that resolves with the validated, frozen definitions,
 * every one run by the backend or on one of its MCP servers, and which of
 * them cannot run now, once the backend answers.
 * @throws A caller-safe error when the backend cannot be reached, answers
 * with another status or media type, or returns a list that does not match
 * the shared schema; the decoding failure is kept as its cause.
 */
export async function listBackendTools(
  connection: ToolApiConnection
): Promise<BackendToolList> {
  const response = await getToolListResponse(connection)
  const mediaType = response.headers.get("content-type")?.split(";")[0].trim()
  try {
    if (
      response.status !== HTTP_OK_STATUS ||
      mediaType !== "application/json"
    ) {
      await response.body?.cancel()
      throw new Error(
        `Unexpected tool list response (HTTP ${response.status}).`
      )
    }
    const payload: unknown = await response.json()
    const list = listBackendToolsApi.responses[HTTP_OK_STATUS].parse(payload)
    const unavailableTools = new Map(
      list.unavailableTools.map((tool) => [tool.name, tool.reason] as const)
    )
    return Object.freeze({ tools: list.tools, unavailableTools })
  } catch (cause) {
    throw new Error("The backend returned an invalid tool list.", { cause })
  }
}

/**
 * Gets the response to one tool list request, in any HTTP status.
 *
 * @param connection - Backend origin.
 * @returns The response whose body remains owned by the caller.
 * @throws A caller-safe error retaining the transport failure as its cause.
 */
async function getToolListResponse(
  connection: ToolApiConnection
): Promise<Response> {
  try {
    return await fetch(`${connection.backendUrl}${listBackendToolsApi.path}`, {
      method: listBackendToolsApi.method,
      headers: { Accept: "application/json" },
      cache: "no-store"
    })
  } catch (cause) {
    throw new Error("The backend could not be reached.", { cause })
  }
}

/**
 * Asks the backend to check the saved Tavily API key with Tavily.
 *
 * @param connection - Backend origin. The check cannot be cancelled; it ends
 * within the backend's request time limit.
 * @returns The validated outcome; it never contains the key.
 * @throws A caller-safe error when the backend cannot be reached or answers
 * with another status, media type, or shape; the decoding failure is kept as
 * its cause.
 */
export async function sendWebSearchKeyCheck(
  connection: ToolApiConnection
): Promise<CheckWebSearchKeyApiResponse> {
  const response = await sendWebSearchKeyCheckRequest(connection)
  const mediaType = response.headers.get("content-type")?.split(";")[0].trim()
  try {
    if (
      response.status !== HTTP_OK_STATUS ||
      mediaType !== "application/json"
    ) {
      await response.body?.cancel()
      throw new Error(
        `Unexpected key check response (HTTP ${response.status}).`
      )
    }
    const payload: unknown = await response.json()
    return checkWebSearchKeyApi.responses[HTTP_OK_STATUS].parse(payload)
  } catch (cause) {
    throw new Error("The backend returned an invalid key check.", { cause })
  }
}

/**
 * Sends one key check as a JSON POST and returns its response, in any HTTP
 * status.
 *
 * @param connection - Backend origin.
 * @returns The response whose body remains owned by the caller.
 * @throws A caller-safe error retaining the transport failure as its cause.
 */
async function sendWebSearchKeyCheckRequest(
  connection: ToolApiConnection
): Promise<Response> {
  try {
    return await fetch(`${connection.backendUrl}${checkWebSearchKeyApi.path}`, {
      method: checkWebSearchKeyApi.method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(KEY_CHECK_REQUEST_BODY),
      cache: "no-store"
    })
  } catch (cause) {
    throw new Error("The backend could not be reached.", { cause })
  }
}
