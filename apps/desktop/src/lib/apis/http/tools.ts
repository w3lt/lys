import { listBackendToolsApi } from "@lys/protocol"
import type { ToolDefinition } from "@lys/share"

/** Transport scope sampled once for one tool request. */
export type ToolApiConnection = {
  /** Application-owned backend origin without a trailing slash. */
  readonly backendUrl: string
}

/** HTTP status of a successful list. */
const HTTP_OK_STATUS = 200

/**
 * Lists every tool the backend runs, in the order Settings shows them.
 *
 * @param connection - Backend origin. The read cannot be cancelled; the
 * tool store owns it.
 * @returns A promise that resolves with the validated, frozen definitions
 * once the backend answers; every one runs in the backend.
 * @throws A caller-safe error when the backend cannot be reached, answers
 * with another status or media type, or returns a list that does not match
 * the shared schema; the decoding failure is kept as its cause.
 */
export async function listBackendTools(
  connection: ToolApiConnection
): Promise<readonly ToolDefinition[]> {
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
    return listBackendToolsApi.responses[HTTP_OK_STATUS].parse(payload).tools
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
