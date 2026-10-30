import { SdkErrorCode } from "@modelcontextprotocol/client"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import type { ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import { calculateMcpRequestFailure } from "../../../../src/modules/mcp/mcpError"
import McpServerConnection from "../../../../src/modules/mcp/mcpServerConnection"
import { MCP_SERVER_STOP_STEP_MILLISECONDS } from "../../../../src/modules/mcp/mcpServerProcess"
import {
  MAXIMUM_MCP_RESPONSE_BYTES,
  McpResponseTooLargeError
} from "../../../../src/modules/mcp/mcpResponseLimit"
import {
  answerAsMcpServer,
  answerToolCallsWith,
  answerWithStatus,
  buildSizedTextResult,
  buildFakeLauncherServerSettings,
  buildFakeStdioServerSettings,
  buildHttpServerSettings,
  createRecordingContext,
  ECHO_TOOL,
  findReportedProcessId,
  isProcessRunning,
  startFakeMcpHttpServer
} from "../../support/mcpTestServers"

/** Longest a test waits for something a server process reports. */
const EVENT_WAIT = Object.freeze({ timeout: 5000 })

/**
 * Longest a test waits for a process group that ends only at `SIGKILL`,
 * three stop steps after its close started.
 */
const PROCESS_GROUP_STOP_WAIT = Object.freeze({
  timeout: 3 * MCP_SERVER_STOP_STEP_MILLISECONDS + 2000
})

/** Time limit of a test that waits for such a process group. */
const PROCESS_GROUP_STOP_TEST_TIMEOUT =
  4 * MCP_SERVER_STOP_STEP_MILLISECONDS + 5000

/** How much earlier than asked a timer may fire on a busy test machine. */
const TIMER_TOLERANCE_MILLISECONDS = 50

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

/** Synthetic body of a server's HTTP error answer, which no log may hold. */
const SYNTHETIC_ANSWER_BODY = "SYNTHETIC-SERVER-ANSWER-BODY-0123"

/**
 * Lists the texts an error carries that a log entry could hold: its string
 * form, message, and stack, and those of its causes.
 *
 * @param error - What was thrown or reported.
 * @returns The texts, the error's own first.
 */
function listErrorTexts(error: unknown): readonly string[] {
  if (!(error instanceof Error)) return [String(error)]
  return [
    String(error),
    error.message,
    error.stack ?? "",
    ...(error.cause === undefined ? [] : listErrorTexts(error.cause))
  ]
}

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

    expect(calculateMcpRequestFailure(rejection)).toEqual({
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

    const result = await connection.sendToolCall(
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

    const result = await connection.sendToolCall(
      "structured",
      {},
      NEVER_ABORTED
    )

    expect(result).toEqual({ content: [], structuredContent: { answer: 42 } })
  })

  it("accepts an answer line as long as the response limit, longer than the SDK's own default", async () => {
    const { context } = createRecordingContext()
    const connection = await openForTest(
      buildFakeStdioServerSettings("fake"),
      context
    )

    const result = await connection.sendToolCall(
      "sized",
      { lineBytes: MAXIMUM_MCP_RESPONSE_BYTES },
      NEVER_ABORTED
    )

    expect(result.content).toHaveLength(1)
  })

  it(
    "ends the connection at an answer line longer than the response limit, reporting why, and a later close waits for the process",
    async () => {
      const { context, events } = createRecordingContext()
      const connection = await openForTest(
        buildFakeStdioServerSettings("fake", {
          ignoreClosedInput: true,
          reportProcessId: true
        }),
        context
      )

      const error = await captureRejection(
        connection.sendToolCall(
          "sized",
          { lineBytes: MAXIMUM_MCP_RESPONSE_BYTES + 1 },
          NEVER_ABORTED
        )
      )
      const processId = findReportedProcessId(events.logLines, "pid")
      await connection.close()

      expect(error).toBeInstanceOf(McpResponseTooLargeError)
      expect(calculateMcpRequestFailure(error)).toEqual({ kind: "too-large" })
      expect(isProcessRunning(processId)).toBe(false)
      expect(events.closedCount).toBe(1)
      expect(filterTooLargeErrors(events.errors)).toHaveLength(1)
    },
    PROCESS_GROUP_STOP_TEST_TIMEOUT
  )

  it("tells the server a cancelled call was cancelled and rejects the call", async () => {
    const { context, events } = createRecordingContext()
    const connection = await openForTest(
      buildFakeStdioServerSettings("fake"),
      context
    )
    const controller = new AbortController()
    const call = connection.sendToolCall("slow", {}, controller.signal)
    // The server answers in arrival order, so this answer proves it received
    // the slow call.
    await connection.sendToolCall("echo", { text: "after" }, NEVER_ABORTED)

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
      connection.sendToolCall("exit", {}, NEVER_ABORTED)
    )
    await vi.waitFor(() => expect(events.closedCount).toBe(1), EVENT_WAIT)
    await connection.close()

    expect(calculateMcpRequestFailure(error)).toEqual({ kind: "closed" })
    expect(events.closedCount).toBe(1)
  })

  it(
    "ends a server a launcher runs, which ignores its closed input and SIGTERM, with its whole process group before the close settles",
    async () => {
      const { context, events } = createRecordingContext()
      const connection = await McpServerConnection.open(
        buildFakeLauncherServerSettings("fake", {
          ignoreClosedInput: true,
          ignoreSigterm: true,
          reportProcessId: true
        }),
        context
      )
      await connection.sendToolCall("echo", { text: "ready" }, NEVER_ABORTED)
      const serverId = findReportedProcessId(events.logLines, "pid")
      const launcherId = findReportedProcessId(events.logLines, "launcher pid")
      const startedAt = performance.now()

      await connection.close()

      expect(isProcessRunning(serverId)).toBe(false)
      expect(isProcessRunning(launcherId)).toBe(false)
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(
        2 * MCP_SERVER_STOP_STEP_MILLISECONDS - TIMER_TOLERANCE_MILLISECONDS
      )
      expect(events.closedCount).toBe(0)
    },
    PROCESS_GROUP_STOP_TEST_TIMEOUT
  )

  it("ends a server a launcher runs once its input closes, without a signal", async () => {
    const { context, events } = createRecordingContext()
    const connection = await McpServerConnection.open(
      buildFakeLauncherServerSettings("fake", { reportProcessId: true }),
      context
    )
    await connection.sendToolCall("echo", { text: "ready" }, NEVER_ABORTED)
    const serverId = findReportedProcessId(events.logLines, "pid")
    const startedAt = performance.now()

    await connection.close()

    expect(isProcessRunning(serverId)).toBe(false)
    expect(performance.now() - startedAt).toBeLessThan(
      MCP_SERVER_STOP_STEP_MILLISECONDS
    )
  })

  it(
    "ends the rest of its process group when the command exits by itself, before it reports the ended connection",
    async () => {
      const { context, events } = createRecordingContext()
      const connection = await openForTest(
        buildFakeStdioServerSettings("fake", { startHelper: true }),
        context
      )
      await connection.sendToolCall("echo", { text: "ready" }, NEVER_ABORTED)
      const helperId = findReportedProcessId(events.logLines, "helper pid")

      const error = await captureRejection(
        connection.sendToolCall("exit", {}, NEVER_ABORTED)
      )
      await vi.waitFor(
        () => expect(events.closedCount).toBe(1),
        PROCESS_GROUP_STOP_WAIT
      )

      expect(calculateMcpRequestFailure(error)).toEqual({ kind: "closed" })
      expect(isProcessRunning(helperId)).toBe(false)
    },
    PROCESS_GROUP_STOP_TEST_TIMEOUT
  )

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
    await connection.sendToolCall("echo", { text: "hi" }, NEVER_ABORTED)
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
      await connection.sendToolCall("echo", { text: "hi" }, NEVER_ABORTED)
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

    const result = await connection.sendToolCall("echo", {}, NEVER_ABORTED)

    expect(result.content).toHaveLength(1)
  })

  it.each([
    {
      form: "JSON",
      answerCall: (id: number, response: ServerResponse): void => {
        response.writeHead(200, JSON_ANSWER_HEADERS)
        response.end(buildSizedTextResult(id, MAXIMUM_MCP_RESPONSE_BYTES + 1))
      }
    },
    {
      form: "event stream",
      answerCall: (_id: number, response: ServerResponse): void => {
        response.writeHead(200, EVENT_STREAM_ANSWER_HEADERS)
        response.write(`data: ${"x".repeat(MAXIMUM_MCP_RESPONSE_BYTES)}`)
      }
    }
  ])(
    "fails a call at once as too-large when its $form answer passes the response limit, and ends the connection",
    async ({ answerCall }) => {
      const server = await startFakeMcpHttpServer(
        answerToolCallsWith(answerCall)
      )
      const { context, events } = createRecordingContext()
      const connection = await openForTest(
        buildHttpServerSettings("remote", server.url),
        context
      )

      const error = await captureRejection(
        connection.sendToolCall("echo", {}, NEVER_ABORTED)
      )

      expect(calculateMcpRequestFailure(error)).toEqual({ kind: "too-large" })
      expect(events.closedCount).toBe(1)
      expect(filterTooLargeErrors(events.errors)).toHaveLength(1)
    }
  )

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
      connection.sendToolCall("echo", {}, NEVER_ABORTED)
    )
    await vi.waitFor(() => expect(answeredCallCount).toBe(1), EVENT_WAIT)

    const failedCall = await captureRejection(
      connection.sendToolCall("echo", {}, NEVER_ABORTED)
    )

    expect(calculateMcpRequestFailure(failedCall)).toEqual({
      kind: "too-large"
    })
    expect(calculateMcpRequestFailure(await waitingCall)).toEqual({
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
      connection.sendToolCall("echo", {}, NEVER_ABORTED)
    )
    const secondError = await captureRejection(
      connection.sendToolCall("echo", {}, NEVER_ABORTED)
    )

    expect(calculateMcpRequestFailure(firstError)).toEqual({
      kind: "http-status",
      status: 404
    })
    expect(calculateMcpRequestFailure(secondError)).toEqual({
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
      connection.sendToolCall("echo", {}, NEVER_ABORTED)
    )

    expect(calculateMcpRequestFailure(error)).toEqual({
      kind: "http-status",
      status: 500
    })
    expect(events.closedCount).toBe(0)
  })

  it("returns one promise for every close and does not report it as an ended connection", async () => {
    const server = await startFakeMcpHttpServer(answerAsMcpServer())
    const { context, events } = createRecordingContext()
    const connection = await McpServerConnection.open(
      buildHttpServerSettings("remote", server.url),
      context
    )

    const firstClose = connection.close()
    const secondClose = connection.close()
    await firstClose

    expect(secondClose).toBe(firstClose)
    expect(events.closedCount).toBe(0)
  })

  it("closes with a call in flight without reporting the aborted request as a connection error", async () => {
    let receivedCallCount = 0
    const server = await startFakeMcpHttpServer(
      answerToolCallsWith(() => {
        receivedCallCount += 1
      })
    )
    const { context, events } = createRecordingContext()
    const connection = await McpServerConnection.open(
      buildHttpServerSettings("remote", server.url),
      context
    )
    const call = captureRejection(
      connection.sendToolCall("echo", {}, NEVER_ABORTED)
    )
    await vi.waitFor(() => expect(receivedCallCount).toBe(1), EVENT_WAIT)

    await connection.close()

    expect(calculateMcpRequestFailure(await call)).toEqual({ kind: "closed" })
    expect(events.errors).toEqual([])
    expect(events.closedCount).toBe(0)
  })

  it("reports a call answered with an HTTP error only through the call's own failure", async () => {
    const server = await startFakeMcpHttpServer(
      answerToolCallsWith((_id, response) => {
        response.writeHead(500)
        response.end(SYNTHETIC_ANSWER_BODY)
      })
    )
    const { context, events } = createRecordingContext()
    const connection = await openForTest(
      buildHttpServerSettings("remote", server.url),
      context
    )

    const error = await captureRejection(
      connection.sendToolCall("echo", {}, NEVER_ABORTED)
    )

    expect(calculateMcpRequestFailure(error)).toEqual({
      kind: "http-status",
      status: 500
    })
    expect(listErrorTexts(error)).not.toContainEqual(
      expect.stringContaining(SYNTHETIC_ANSWER_BODY)
    )
    expect(events.errors).toEqual([])
  })

  it("reports a cancellation the server answers with an HTTP error once, without the answer's body", async () => {
    const answerOther = answerToolCallsWith(() => {
      // The call is never answered, so only its cancellation ends it.
    })
    const server = await startFakeMcpHttpServer((request, body, response) => {
      if (body.includes('"notifications/cancelled"')) {
        response.writeHead(500)
        response.end(SYNTHETIC_ANSWER_BODY)
        return
      }
      answerOther(request, body, response)
    })
    const { context, events } = createRecordingContext()
    const connection = await openForTest(
      buildHttpServerSettings("remote", server.url),
      context
    )
    const controller = new AbortController()
    const call = captureRejection(
      connection.sendToolCall("echo", {}, controller.signal)
    )
    await vi.waitFor(() => {
      expect(
        server.receivedRequests.map((request) => request.rpcMethod)
      ).toContain("tools/call")
    }, EVENT_WAIT)

    controller.abort(new Error("The person stopped the reply"))
    await call

    await vi.waitFor(() => expect(events.errors).toHaveLength(1), EVENT_WAIT)
    expect(
      server.receivedRequests.map((request) => request.rpcMethod)
    ).toContain("notifications/cancelled")
    expect(events.errors.flatMap(listErrorTexts)).not.toContainEqual(
      expect.stringContaining(SYNTHETIC_ANSWER_BODY)
    )
  })

  it("reports an event of a call's event stream that is not JSON once, and returns the call's result", async () => {
    const server = await startFakeMcpHttpServer(
      answerToolCallsWith((id, response) => {
        response.writeHead(200, EVENT_STREAM_ANSWER_HEADERS)
        response.end(
          `data: {no\n\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result: { content: [] } })}\n\n`
        )
      })
    )
    const { context, events } = createRecordingContext()
    const connection = await openForTest(
      buildHttpServerSettings("remote", server.url),
      context
    )

    const result = await connection.sendToolCall("echo", {}, NEVER_ABORTED)
    await connection.sendToolCall("echo", {}, NEVER_ABORTED)

    expect(result).toEqual({ content: [] })
    expect(events.errors.map((error) => error.constructor)).toEqual([
      SyntaxError,
      SyntaxError
    ])
  })

  it("reports an event stream the server refuses to open once", async () => {
    const answerOther = answerAsMcpServer()
    const server = await startFakeMcpHttpServer((request, body, response) => {
      if (request.method === "GET") {
        response.writeHead(500).end(SYNTHETIC_ANSWER_BODY)
        return
      }
      answerOther(request, body, response)
    })
    const { context, events } = createRecordingContext()
    const connection = await openForTest(
      buildHttpServerSettings("remote", server.url),
      context
    )
    await vi.waitFor(() => expect(events.errors).not.toEqual([]), EVENT_WAIT)

    // The SDK reports the refusal a second time right after the first; a
    // request answered after that shows it was passed on only once.
    await connection.sendToolCall("echo", { text: "after" }, NEVER_ABORTED)

    expect(events.errors).toHaveLength(1)
    expect(calculateMcpRequestFailure(events.errors[0])).toEqual({
      kind: "http-status",
      status: 500
    })
  })

  it("keeps a connection whose event stream sends more than the response limit in events each within it", async () => {
    const answerOther = answerAsMcpServer()
    const notification = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/message",
      params: { level: "info", data: "x".repeat(1024 * 1024) }
    })
    let eventStreamCount = 0
    const server = await startFakeMcpHttpServer((request, body, response) => {
      if (request.method !== "GET") {
        answerOther(request, body, response)
        return
      }
      eventStreamCount += 1
      if (eventStreamCount > 1) {
        response.writeHead(405).end()
        return
      }
      // A short retry time makes the SDK open the stream again soon after it
      // read this one to its end, which shows it read every event.
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.write("retry: 10\n\n")
      for (let index = 0; index < 17; index += 1)
        response.write(`data: ${notification}\n\n`)
      response.end()
    })
    const { context, events } = createRecordingContext()
    const connection = await openForTest(
      buildHttpServerSettings("remote", server.url),
      context
    )

    await vi.waitFor(
      () => expect(eventStreamCount > 1 || events.closedCount > 0).toBe(true),
      EVENT_WAIT
    )

    expect(events.closedCount).toBe(0)
    expect(events.errors).toEqual([])
    await expect(
      connection.sendToolCall("echo", { text: "after" }, NEVER_ABORTED)
    ).resolves.toEqual(expect.objectContaining({ content: expect.any(Array) }))
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

    expect(calculateMcpRequestFailure(error)).toEqual({
      kind: "http-status",
      status: 307
    })
    expect(server.receivedRequests).not.toEqual([])
    expect(movedRequestMethods).toEqual([])
  })
})
