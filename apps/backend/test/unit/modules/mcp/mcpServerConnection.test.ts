import { SdkErrorCode } from "@modelcontextprotocol/client"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import { classifyMcpRequestFailure } from "../../../../src/modules/mcp/mcpError"
import McpServerConnection from "../../../../src/modules/mcp/mcpServerConnection"
import {
  MAXIMUM_MCP_RESPONSE_BYTES,
  McpResponseTooLargeError
} from "../../../../src/modules/mcp/mcpResponseLimit"
import {
  answerAsMcpServer,
  answerToolCallsWith,
  answerWithStatus,
  buildSizedTextResult,
  buildFakeStdioServerSettings,
  buildHttpServerSettings,
  createRecordingContext,
  ECHO_TOOL,
  startFakeMcpHttpServer
} from "../../support/mcpTestServers"

/** Longest a test waits for something a server process reports. */
const EVENT_WAIT = Object.freeze({ timeout: 5000 })

/** Synthetic bearer token; not a real credential. */
const SYNTHETIC_AUTHORIZATION = "Bearer synthetic-token-0123"

/** Headers of a fake server's JSON answer within its session. */
const JSON_ANSWER_HEADERS = Object.freeze({
  "content-type": "application/json",
  "mcp-session-id": "test-session"
})

/** Headers of a fake server's event stream answer within its session. */
const EVENT_STREAM_ANSWER_HEADERS = Object.freeze({
  "content-type": "text/event-stream",
  "mcp-session-id": "test-session"
})

/** A signal that never aborts, for calls a test does not cancel. */
const NEVER_ABORTED = new AbortController().signal

/**
 * Opens a connection and closes it when the current test finishes.
 *
 * @param settings - Settings of the server.
 * @param context - Context the connection reports to.
 * @returns The open connection.
 */
async function openForTest(
  ...[settings, context]: Parameters<typeof McpServerConnection.open>
): Promise<McpServerConnection> {
  const connection = await McpServerConnection.open(settings, context)
  onTestFinished(() => connection.close())
  return connection
}

/**
 * Creates an empty folder removed when the current test finishes.
 *
 * @returns Its absolute path with symbolic links resolved, as a process
 * started in it reports its working folder.
 */
async function createWorkingFolder(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "lys-mcp-cwd-"))
  onTestFinished(() => rm(folder, { recursive: true, force: true }))
  return await realpath(folder)
}

/**
 * Keeps the reported failures that name an answer over the response limit.
 *
 * @param errors - Failures the connection reported.
 * @returns Each one that is a {@link McpResponseTooLargeError}.
 */
function filterTooLargeErrors(errors: readonly Error[]): readonly Error[] {
  return errors.filter((error) => error instanceof McpResponseTooLargeError)
}

/**
 * Runs a promise expected to reject and keeps what it rejected with.
 *
 * @param promise - Promise to settle.
 * @returns The rejection.
 * @throws When the promise fulfills.
 */
async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("Expected the promise to reject")
}

describe("McpServerConnection over stdio", () => {
  it("starts the server in the working folder with the configured variables", async () => {
    const workingFolder = await createWorkingFolder()
    const { context, events } = createRecordingContext()
    const settings = buildFakeStdioServerSettings(
      "fake",
      { reportEnvironment: ["LYS_TEST_VALUE"] },
      [{ name: "LYS_TEST_VALUE", value: "synthetic-value" }]
    )

    await openForTest(settings, { ...context, workingDirectory: workingFolder })

    await vi.waitFor(() => {
      expect(events.logLines).toEqual([
        "fake server started",
        `cwd ${workingFolder}`,
        "env LYS_TEST_VALUE=synthetic-value"
      ])
    }, EVENT_WAIT)
  })

  it("does not pass on a backend variable outside the SDK's default set", async () => {
    vi.stubEnv("LYS_TEST_BACKEND_ONLY", "backend-only-value")
    const { context, events } = createRecordingContext()
    const settings = buildFakeStdioServerSettings("fake", {
      reportEnvironment: ["LYS_TEST_BACKEND_ONLY"]
    })

    await openForTest(settings, context)

    await vi.waitFor(() => {
      expect(events.logLines).toContain("env LYS_TEST_BACKEND_ONLY=<unset>")
    }, EVENT_WAIT)
  })

  it("reports each line the server writes to its standard error", async () => {
    const { context, events } = createRecordingContext()

    await openForTest(buildFakeStdioServerSettings("fake"), context)

    await vi.waitFor(() => {
      expect(events.logLines).toEqual(["fake server started"])
    }, EVENT_WAIT)
  })

  it("fails a command that cannot start as start-failed without reporting the spawn error, which holds the arguments", async () => {
    const { context, events } = createRecordingContext()
    const settings = Object.freeze({
      name: "missing",
      transport: "stdio",
      command: join(tmpdir(), "lys-test-missing-command"),
      arguments: Object.freeze(["--token", "synthetic-argument-0123"]),
      environment: Object.freeze([])
    } as const)

    const rejection = await captureRejection(
      McpServerConnection.open(settings, context)
    )

    expect(classifyMcpRequestFailure(rejection)).toEqual({
      kind: "start-failed"
    })
    expect(events.errors).toEqual([])
  })

  it("lists the server's tools", async () => {
    const { context } = createRecordingContext()
    const connection = await openForTest(
      buildFakeStdioServerSettings("fake"),
      context
    )

    expect(await connection.listTools(NEVER_ABORTED)).toEqual([ECHO_TOOL])
  })

  it("calls a tool and returns the server's result", async () => {
    const { context } = createRecordingContext()
    const connection = await openForTest(
      buildFakeStdioServerSettings("fake"),
      context
    )

    const result = await connection.callTool(
      "echo",
      { text: "hi" },
      NEVER_ABORTED
    )

    expect(result).toEqual({
      content: [{ type: "text", text: 'echo: {"text":"hi"}' }]
    })
  })

  it("returns structured content without checking it against the output schema the server listed, whose patterns never run", async () => {
    const { context } = createRecordingContext()
    const connection = await openForTest(
      buildFakeStdioServerSettings("fake", {
        tools: [
          {
            name: "structured",
            description: "Returns structured content.",
            inputSchema: { type: "object" },
            outputSchema: {
              type: "object",
              properties: { answer: { type: "string", pattern: "^(a+)+$" } },
              required: ["answer"]
            }
          }
        ]
      }),
      context
    )
    await connection.listTools(NEVER_ABORTED)

    const result = await connection.callTool("structured", {}, NEVER_ABORTED)

    expect(result).toEqual({ content: [], structuredContent: { answer: 42 } })
  })

  it("accepts an answer line as long as the response limit, longer than the SDK's own default", async () => {
    const { context } = createRecordingContext()
    const connection = await openForTest(
      buildFakeStdioServerSettings("fake"),
      context
    )

    const result = await connection.callTool(
      "sized",
      { lineBytes: MAXIMUM_MCP_RESPONSE_BYTES },
      NEVER_ABORTED
    )

    expect(result.content).toHaveLength(1)
  })

  it("ends the connection at an answer line longer than the response limit, reporting why", async () => {
    const { context, events } = createRecordingContext()
    const connection = await openForTest(
      buildFakeStdioServerSettings("fake"),
      context
    )

    const error = await captureRejection(
      connection.callTool(
        "sized",
        { lineBytes: MAXIMUM_MCP_RESPONSE_BYTES + 1 },
        NEVER_ABORTED
      )
    )

    expect(classifyMcpRequestFailure(error)).toEqual({ kind: "closed" })
    await vi.waitFor(() => expect(events.closedCount).toBe(1), EVENT_WAIT)
    expect(events.errors.map((reported) => reported.message)).toContainEqual(
      expect.stringContaining(`${MAXIMUM_MCP_RESPONSE_BYTES} bytes`)
    )
  })

  it("tells the server a cancelled call was cancelled and rejects the call", async () => {
    const { context, events } = createRecordingContext()
    const connection = await openForTest(
      buildFakeStdioServerSettings("fake"),
      context
    )
    const controller = new AbortController()
    const call = connection.callTool("slow", {}, controller.signal)
    // The server answers in arrival order, so this answer proves it received
    // the slow call.
    await connection.callTool("echo", { text: "after" }, NEVER_ABORTED)

    controller.abort(new Error("The person stopped the reply"))

    await expect(call).rejects.toMatchObject({
      code: SdkErrorCode.RequestTimeout
    })
    await vi.waitFor(() => {
      expect(
        events.logLines.filter((line) => line.startsWith("cancelled "))
      ).toHaveLength(1)
    }, EVENT_WAIT)
  })

  it("reports a connection the server ended once, and fails the call in flight as closed", async () => {
    const { context, events } = createRecordingContext()
    const connection = await openForTest(
      buildFakeStdioServerSettings("fake"),
      context
    )

    const error = await captureRejection(
      connection.callTool("exit", {}, NEVER_ABORTED)
    )
    await vi.waitFor(() => expect(events.closedCount).toBe(1), EVENT_WAIT)
    await connection.close()

    expect(classifyMcpRequestFailure(error)).toEqual({ kind: "closed" })
    expect(events.closedCount).toBe(1)
  })

  it("returns one promise for every close and does not report it as an ended connection", async () => {
    const { context, events } = createRecordingContext()
    const connection = await McpServerConnection.open(
      buildFakeStdioServerSettings("fake"),
      context
    )

    const firstClose = connection.close()
    const secondClose = connection.close()
    await firstClose

    expect(secondClose).toBe(firstClose)
    expect(connection.close()).toBe(firstClose)
    expect(events.closedCount).toBe(0)
  })
})

describe("McpServerConnection over HTTP", () => {
  it("sends the configured headers with every request", async () => {
    const server = await startFakeMcpHttpServer(answerAsMcpServer())
    const { context } = createRecordingContext()
    const connection = await McpServerConnection.open(
      buildHttpServerSettings("remote", server.url, [
        { name: "Authorization", value: SYNTHETIC_AUTHORIZATION },
        { name: "X-Lys-Test", value: "one" }
      ]),
      context
    )

    await connection.listTools(NEVER_ABORTED)
    await connection.callTool("echo", { text: "hi" }, NEVER_ABORTED)
    await connection.close()

    expect(server.receivedRequests.map((request) => request.rpcMethod)).toEqual(
      expect.arrayContaining(["initialize", "tools/list", "tools/call"])
    )
    expect(
      server.receivedRequests.filter(
        (request) =>
          request.headers.authorization !== SYNTHETIC_AUTHORIZATION ||
          request.headers["x-lys-test"] !== "one"
      )
    ).toEqual([])
  })

  it("returns a tool's result over HTTP", async () => {
    const server = await startFakeMcpHttpServer(answerAsMcpServer())
    const { context } = createRecordingContext()
    const connection = await openForTest(
      buildHttpServerSettings("remote", server.url),
      context
    )

    expect(
      await connection.callTool("echo", { text: "hi" }, NEVER_ABORTED)
    ).toEqual({ content: [{ type: "text", text: 'echo: {"text":"hi"}' }] })
  })

  it("returns an answer whose body is as long as the response limit", async () => {
    const server = await startFakeMcpHttpServer(
      answerToolCallsWith((id, response) => {
        response.writeHead(200, JSON_ANSWER_HEADERS)
        response.end(buildSizedTextResult(id, MAXIMUM_MCP_RESPONSE_BYTES))
      })
    )
    const { context } = createRecordingContext()
    const connection = await openForTest(
      buildHttpServerSettings("remote", server.url),
      context
    )

    const result = await connection.callTool("echo", {}, NEVER_ABORTED)

    expect(result.content).toHaveLength(1)
  })

  it("fails a call whose answer is longer than the response limit as too-large, and ends the connection", async () => {
    const server = await startFakeMcpHttpServer(
      answerToolCallsWith((id, response) => {
        response.writeHead(200, JSON_ANSWER_HEADERS)
        response.end(buildSizedTextResult(id, MAXIMUM_MCP_RESPONSE_BYTES + 1))
      })
    )
    const { context, events } = createRecordingContext()
    const connection = await openForTest(
      buildHttpServerSettings("remote", server.url),
      context
    )

    const error = await captureRejection(
      connection.callTool("echo", {}, NEVER_ABORTED)
    )

    expect(classifyMcpRequestFailure(error)).toEqual({ kind: "too-large" })
    expect(events.closedCount).toBe(1)
    expect(filterTooLargeErrors(events.errors)).toHaveLength(1)
  })

  it("fails a call at once when its event stream answer passes the response limit, and ends the connection", async () => {
    const server = await startFakeMcpHttpServer(
      answerToolCallsWith((_id, response) => {
        response.writeHead(200, EVENT_STREAM_ANSWER_HEADERS)
        response.write(`data: ${"x".repeat(MAXIMUM_MCP_RESPONSE_BYTES)}`)
      })
    )
    const { context, events } = createRecordingContext()
    const connection = await openForTest(
      buildHttpServerSettings("remote", server.url),
      context
    )

    const error = await captureRejection(
      connection.callTool("echo", {}, NEVER_ABORTED)
    )

    expect(classifyMcpRequestFailure(error)).toEqual({ kind: "too-large" })
    expect(events.closedCount).toBe(1)
    expect(filterTooLargeErrors(events.errors)).toHaveLength(1)
  })

  it("fails every call in flight once one answer passes the response limit", async () => {
    let answeredCallCount = 0
    const server = await startFakeMcpHttpServer(
      answerToolCallsWith((id, response) => {
        answeredCallCount += 1
        response.writeHead(200, JSON_ANSWER_HEADERS)
        if (answeredCallCount > 1)
          response.end(buildSizedTextResult(id, MAXIMUM_MCP_RESPONSE_BYTES + 1))
      })
    )
    const { context } = createRecordingContext()
    const connection = await openForTest(
      buildHttpServerSettings("remote", server.url),
      context
    )
    const waitingCall = captureRejection(
      connection.callTool("echo", {}, NEVER_ABORTED)
    )
    await vi.waitFor(() => expect(answeredCallCount).toBe(1), EVENT_WAIT)

    const failedCall = await captureRejection(
      connection.callTool("echo", {}, NEVER_ABORTED)
    )

    expect(classifyMcpRequestFailure(failedCall)).toEqual({ kind: "too-large" })
    expect(classifyMcpRequestFailure(await waitingCall)).toEqual({
      kind: "too-large"
    })
  })

  it("reports a session the server answers with HTTP 404 once as an ended connection, and fails the calls", async () => {
    const server = await startFakeMcpHttpServer(
      answerToolCallsWith((_id, response) => {
        response.writeHead(404)
        response.end("Session not found")
      })
    )
    const { context, events } = createRecordingContext()
    const connection = await openForTest(
      buildHttpServerSettings("remote", server.url),
      context
    )

    const firstError = await captureRejection(
      connection.callTool("echo", {}, NEVER_ABORTED)
    )
    const secondError = await captureRejection(
      connection.callTool("echo", {}, NEVER_ABORTED)
    )

    expect(classifyMcpRequestFailure(firstError)).toEqual({
      kind: "http-status",
      status: 404
    })
    expect(classifyMcpRequestFailure(secondError)).toEqual({
      kind: "http-status",
      status: 404
    })
    expect(events.closedCount).toBe(1)
  })

  it("does not report a call answered with another HTTP error as an ended connection", async () => {
    const server = await startFakeMcpHttpServer(
      answerToolCallsWith((_id, response) => {
        response.writeHead(500)
        response.end("Internal error")
      })
    )
    const { context, events } = createRecordingContext()
    const connection = await openForTest(
      buildHttpServerSettings("remote", server.url),
      context
    )

    const error = await captureRejection(
      connection.callTool("echo", {}, NEVER_ABORTED)
    )

    expect(classifyMcpRequestFailure(error)).toEqual({
      kind: "http-status",
      status: 500
    })
    expect(events.closedCount).toBe(0)
  })

  it("refuses a redirect within the server's own origin without requesting its target", async () => {
    // The SDK refuses redirects to another origin by itself; one that stays
    // on the same host and port is refused only by the transport's settings.
    const answerMoved = answerAsMcpServer()
    const movedRequestMethods: string[] = []
    const server = await startFakeMcpHttpServer((request, body, response) => {
      if (request.url === "/mcp") {
        answerWithStatus(307, { location: "/moved" })(request, body, response)
        return
      }
      movedRequestMethods.push(request.method ?? "")
      answerMoved(request, body, response)
    })
    const { context } = createRecordingContext()

    const error = await captureRejection(
      McpServerConnection.open(
        buildHttpServerSettings("remote", server.url, [
          { name: "Authorization", value: SYNTHETIC_AUTHORIZATION }
        ]),
        context
      )
    )

    expect(classifyMcpRequestFailure(error)).toEqual({
      kind: "http-status",
      status: 307
    })
    expect(server.receivedRequests).not.toEqual([])
    expect(movedRequestMethods).toEqual([])
  })
})
