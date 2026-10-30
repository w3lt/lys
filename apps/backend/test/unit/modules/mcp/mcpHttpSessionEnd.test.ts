import { SdkErrorCode, SdkHttpError } from "@modelcontextprotocol/client"
import { describe, expect, it } from "vitest"
import {
  endMcpHttpSession,
  MCP_SESSION_END_TIMEOUT_MILLISECONDS,
  type McpHttpSession
} from "../../../../src/modules/mcp/mcpHttpSessionEnd"
import {
  answerWithStatus,
  findClosedMcpUrl,
  startFakeMcpHttpServer
} from "../../support/mcpTestServers"

/** Longest a test of the time limit runs. */
const TIME_LIMIT_TEST = Object.freeze({
  timeout: MCP_SESSION_END_TIMEOUT_MILLISECONDS + 5000
})

/**
 * Builds a session with a server at a URL, with one configured header.
 *
 * @param url - Endpoint of the server.
 * @returns The session.
 */
function buildSession(url: string): McpHttpSession {
  return {
    url: new URL(url),
    headers: [["x-team", "lys"]],
    sessionId: "test-session",
    protocolVersion: "2025-11-25"
  }
}

/**
 * Ends a session and records every failure it reports.
 *
 * @param session - Session to end.
 * @returns The reported failures.
 */
async function endSession(session: McpHttpSession): Promise<unknown[]> {
  const failures: unknown[] = []
  await endMcpHttpSession(session, (error) => failures.push(error))
  return failures
}

describe("endMcpHttpSession", () => {
  it("sends DELETE with the configured headers, the session, and the protocol version", async () => {
    const server = await startFakeMcpHttpServer(answerWithStatus(200))

    const failures = await endSession(buildSession(server.url))

    expect(failures).toEqual([])
    expect(server.receivedRequests).toHaveLength(1)
    expect(server.receivedRequests[0]).toMatchObject({
      method: "DELETE",
      headers: {
        "x-team": "lys",
        "mcp-session-id": "test-session",
        "mcp-protocol-version": "2025-11-25"
      }
    })
  })

  it("sends nothing without a session", async () => {
    const server = await startFakeMcpHttpServer(answerWithStatus(200))

    const failures = await endSession({
      ...buildSession(server.url),
      sessionId: undefined
    })

    expect(failures).toEqual([])
    expect(server.receivedRequests).toEqual([])
  })

  it.each([
    [404, "the server no longer knows the session"],
    [405, "the server does not let clients end sessions"]
  ])("does not report status %i, as %s", async (status) => {
    const server = await startFakeMcpHttpServer(answerWithStatus(status))

    expect(await endSession(buildSession(server.url))).toEqual([])
  })

  it("reports another status without the answer's text", async () => {
    const server = await startFakeMcpHttpServer(answerWithStatus(500))

    const failures = await endSession(buildSession(server.url))

    expect(failures).toHaveLength(1)
    const failure = failures[0]
    expect(failure).toBeInstanceOf(SdkHttpError)
    expect(failure).toMatchObject({
      code: SdkErrorCode.ClientHttpFailedToTerminateSession,
      data: { status: 500 }
    })
    expect(failure).toHaveProperty(
      "message",
      expect.not.stringContaining("refused")
    )
  })

  it("follows no redirect and reports it as a status", async () => {
    const target = await startFakeMcpHttpServer(answerWithStatus(200))
    const server = await startFakeMcpHttpServer(
      answerWithStatus(307, { location: target.url })
    )

    const failures = await endSession(buildSession(server.url))

    expect(failures).toEqual([
      expect.objectContaining({ data: { status: 307 } })
    ])
    expect(target.receivedRequests).toEqual([])
  })

  it(
    "gives up on a server that does not answer once the time limit passed",
    TIME_LIMIT_TEST,
    async () => {
      const server = await startFakeMcpHttpServer(() => undefined)
      const startedAt = performance.now()

      const failures = await endSession(buildSession(server.url))

      const elapsed = performance.now() - startedAt
      expect(elapsed).toBeGreaterThanOrEqual(
        MCP_SESSION_END_TIMEOUT_MILLISECONDS - 100
      )
      expect(elapsed).toBeLessThan(MCP_SESSION_END_TIMEOUT_MILLISECONDS + 2000)
      expect(failures).toEqual([
        expect.objectContaining({ name: "TimeoutError" })
      ])
    }
  )

  it("reports a server it cannot reach", async () => {
    const failures = await endSession(buildSession(await findClosedMcpUrl()))

    expect(failures).toEqual([expect.any(TypeError)])
  })
})
