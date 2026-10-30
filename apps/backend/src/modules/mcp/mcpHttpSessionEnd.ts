import { SdkErrorCode, SdkHttpError } from "@modelcontextprotocol/client"

/**
 * Longest the backend waits for an HTTP MCP server to answer the end of
 * its session, in milliseconds, so a close stays bounded when the server
 * does not answer.
 */
export const MCP_SESSION_END_TIMEOUT_MILLISECONDS = 2000

/**
 * Statuses of an answer to the end of a session that are not failures
 * besides a 2xx one: 404, the server no longer knows the session, and 405,
 * the server does not let clients end sessions.
 */
const ACCEPTED_FAILURE_STATUSES: ReadonlySet<number> = new Set([404, 405])

/** The session of one HTTP MCP server, as its connection ends it. */
export type McpHttpSession = Readonly<{
  /** Endpoint of the server, which the end of the session is sent to. */
  url: URL
  /** Headers the settings configure, each as a name and a value. */
  headers: readonly (readonly [string, string])[]
  /** Session the server started at the handshake; undefined for none. */
  sessionId: string | undefined
  /** Protocol version the handshake settled on, if it got that far. */
  protocolVersion: string | undefined
}>

/**
 * Asks an HTTP MCP server to end the session the backend had with it, as
 * the MCP specification asks a client that no longer needs a session to.
 *
 * @param session - The server's endpoint, configured headers, session, and
 * protocol version.
 * @param reportFailure - Told what went wrong when the server did not end
 * the session: an `SdkHttpError` with only the status of an answer other
 * than 2xx, 404, or 405, or what `fetch` threw, such as its timeout after
 * {@link MCP_SESSION_END_TIMEOUT_MILLISECONDS}; borrowed for the call.
 * @returns A promise that settles once the server answered, the request
 * failed, or the time limit passed; it never rejects. Without a session,
 * nothing is sent.
 * @remarks Sends `DELETE` to the endpoint with the configured headers,
 * `Mcp-Session-Id`, and `Mcp-Protocol-Version`, following no redirect, and
 * discards the answer's body. The SDK's own `terminateSession` is not used:
 * after the transport closed, it would send under the transport's aborted
 * signal, and it reports its failure as a failure of the connection.
 */
export async function endMcpHttpSession(
  session: McpHttpSession,
  reportFailure: (error: unknown) => void
): Promise<void> {
  if (session.sessionId === undefined) return
  const headers = new Headers(
    session.headers.map(([name, value]) => [name, value])
  )
  headers.set("mcp-session-id", session.sessionId)
  if (session.protocolVersion !== undefined)
    headers.set("mcp-protocol-version", session.protocolVersion)
  try {
    const response = await fetch(session.url, {
      method: "DELETE",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(MCP_SESSION_END_TIMEOUT_MILLISECONDS)
    })
    await response.body?.cancel()
    if (!response.ok && !ACCEPTED_FAILURE_STATUSES.has(response.status))
      reportFailure(
        new SdkHttpError(
          SdkErrorCode.ClientHttpFailedToTerminateSession,
          `The MCP server answered the end of its session with HTTP status ${response.status}.`,
          { status: response.status }
        )
      )
  } catch (error) {
    reportFailure(error)
  }
}
