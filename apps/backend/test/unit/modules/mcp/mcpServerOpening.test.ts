import type { McpServerSettings } from "@lys/share"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import type { McpServerConnectionContext } from "../../../../src/modules/mcp/mcpServerConnection"
import { MAXIMUM_MCP_RESPONSE_BYTES } from "../../../../src/modules/mcp/mcpResponseLimit"
import {
  openMcpServer,
  type McpServerOpening
} from "../../../../src/modules/mcp/mcpServerOpening"
import type { RecordedConnectionEvents } from "../../support/mcpTestServers"
import {
  answerAsMcpServer,
  answerWithInvalidJson,
  answerWithStatus,
  buildFakeStdioServerSettings,
  buildHttpServerSettings,
  buildSizedTextResult,
  createRecordingContext,
  findClosedMcpUrl,
  startFakeMcpHttpServer
} from "../../support/mcpTestServers"

/** Opening time limit for cases that do not test it. */
const OPENING_TIMEOUT_MILLISECONDS = 10_000

/**
 * Opening time limit for the over-limit event stream cases, shorter than
 * {@link OPENING_TIMEOUT_MILLISECONDS} so an opening that waits for the
 * limit instead of failing at once ends as `timed-out` within the case.
 */
const TOO_LARGE_STREAM_OPENING_TIMEOUT_MILLISECONDS = 3000

/** Longest a test waits for something a server process does. */
const EVENT_WAIT = Object.freeze({ timeout: 5000 })

/**
 * Script of a stdio server that reports its process identifier and never
 * answers, and exits once its standard input ends.
 */
const SILENT_SERVER_SCRIPT = [
  'process.stderr.write("pid " + process.pid + "\\n")',
  "process.stdin.resume()",
  'process.stdin.on("end", () => process.exit(0))'
].join(";")

/** Settings of a stdio server that starts but never answers. */
const SILENT_SERVER_SETTINGS: McpServerSettings = Object.freeze({
  name: "silent",
  transport: "stdio",
  command: process.execPath,
  arguments: Object.freeze(["-e", SILENT_SERVER_SCRIPT]),
  environment: Object.freeze([])
})

/**
 * Script of a stdio server that reports its process identifier, answers
 * the handshake, never answers anything else, and exits once its standard
 * input ends.
 */
const HANDSHAKE_ONLY_SERVER_SCRIPT = [
  'process.stderr.write("pid " + process.pid + "\\n")',
  'require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {',
  "  const message = JSON.parse(line)",
  '  if (message.method !== "initialize") return',
  '  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "handshake-only", version: "1.0.0" } } }) + "\\n")',
  "})"
].join("\n")

/** Settings of a stdio server that connects but never lists its tools. */
const HANDSHAKE_ONLY_SERVER_SETTINGS: McpServerSettings = Object.freeze({
  name: "handshake-only",
  transport: "stdio",
  command: process.execPath,
  arguments: Object.freeze(["-e", HANDSHAKE_ONLY_SERVER_SCRIPT]),
  environment: Object.freeze([])
})

/** Settings of a stdio server whose command no folder of `PATH` holds. */
const MISSING_COMMAND_SETTINGS: McpServerSettings = Object.freeze({
  name: "missing",
  transport: "stdio",
  command: "lys-test-missing-command-7f3a",
  arguments: Object.freeze([]),
  environment: Object.freeze([])
})

/**
 * Opens a server and closes its connection, if it connected, when the
 * current test finishes.
 *
 * @param settings - Settings of the server.
 * @param context - Context the connection reports to.
 * @param timeoutMilliseconds - Opening time limit.
 * @returns The opening.
 */
async function openForTest(
  settings: McpServerSettings,
  context: McpServerConnectionContext,
  timeoutMilliseconds = OPENING_TIMEOUT_MILLISECONDS
): Promise<McpServerOpening> {
  const opening = await openMcpServer(settings, context, timeoutMilliseconds)
  if (opening.status === "connected")
    onTestFinished(() => opening.connection.close())
  return opening
}

/**
 * Answers whether a process is still running.
 *
 * @param pid - Process identifier.
 * @returns False once no process has the identifier.
 * @throws When the process cannot be signalled for another reason.
 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return false
    throw error
  }
}

/**
 * Stops a process if it still runs, for cleanup after a failed case.
 *
 * @param pid - Process identifier.
 */
function stopProcessIfRunning(pid: number): void {
  if (isProcessRunning(pid)) process.kill(pid, "SIGKILL")
}

/**
 * Waits until the silent server reported its process identifier, and stops
 * that process when the current test finishes if it still runs.
 *
 * @param events - What the connection context recorded.
 * @returns The identifier.
 */
async function waitForReportedPid(
  events: RecordedConnectionEvents
): Promise<number> {
  const pid = await vi.waitFor(() => {
    const line = events.logLines.find((logLine) => logLine.startsWith("pid "))
    if (line === undefined) throw new Error("The server has not started yet")
    return Number(line.slice("pid ".length))
  }, EVENT_WAIT)
  onTestFinished(() => stopProcessIfRunning(pid))
  return pid
}

describe("openMcpServer", () => {
  it("connects a stdio server and lists its tools", async () => {
    const { context } = createRecordingContext()

    const opening = await openForTest(
      buildFakeStdioServerSettings("fake"),
      context
    )

    if (opening.status !== "connected")
      throw new Error("Expected the server to connect")
    expect(opening.catalog.definitions.map((tool) => tool.name)).toEqual([
      "mcp__fake__echo"
    ])
    expect(opening.catalog.skippedTools).toEqual([])
    expect(opening.catalog.isToolListCut).toBe(false)
    expect(Object.isFrozen(opening)).toBe(true)
  })

  it("connects an HTTP server and lists its tools by the server's name", async () => {
    const server = await startFakeMcpHttpServer(
      answerAsMcpServer([
        { name: "search", inputSchema: { type: "object" } },
        { name: "", inputSchema: { type: "object" } }
      ])
    )
    const { context } = createRecordingContext()

    const opening = await openForTest(
      buildHttpServerSettings("remote", server.url),
      context
    )

    if (opening.status !== "connected")
      throw new Error("Expected the server to connect")
    expect(opening.catalog.definitions.map((tool) => tool.name)).toEqual([
      "mcp__remote__search"
    ])
    expect(opening.catalog.skippedTools).toEqual([
      { name: "", reason: "unsupported-name" }
    ])
  })

  it.each([
    [401, "unauthorized"],
    [403, "unauthorized"],
    [500, "http-error"],
    [302, "http-error"]
  ])("reports HTTP status %i as %s", async (status, reason) => {
    const server = await startFakeMcpHttpServer(
      answerWithStatus(status, { location: "http://127.0.0.1:9/elsewhere" })
    )
    const { context } = createRecordingContext()

    const opening = await openForTest(
      buildHttpServerSettings("remote", server.url),
      context
    )

    expect(opening).toEqual({
      status: "failed",
      reason,
      failure: { kind: "http-status", status },
      unknownError: undefined
    })
    expect(Object.isFrozen(opening)).toBe(true)
  })

  it("reports a port nothing listens on as unreachable", async () => {
    const { context } = createRecordingContext()

    const opening = await openForTest(
      buildHttpServerSettings("remote", await findClosedMcpUrl()),
      context
    )

    expect(opening).toEqual({
      status: "failed",
      reason: "unreachable",
      failure: { kind: "unreachable" },
      unknownError: undefined
    })
  })

  it("reports a command that is not found as start-failed", async () => {
    const { context } = createRecordingContext()

    const opening = await openForTest(MISSING_COMMAND_SETTINGS, context)

    expect(opening).toEqual({
      status: "failed",
      reason: "start-failed",
      failure: { kind: "start-failed" },
      unknownError: undefined
    })
  })

  it("reports a server that exits before answering as closed", async () => {
    const { context } = createRecordingContext()

    const opening = await openForTest(
      buildFakeStdioServerSettings("fake", { exitOnStart: 3 }),
      context
    )

    expect(opening).toEqual({
      status: "failed",
      reason: "closed",
      failure: { kind: "closed" },
      unknownError: undefined
    })
  })

  it("reports a refused tool list as a protocol error, closing what it opened without reporting an ended connection", async () => {
    const { context, events } = createRecordingContext()

    const opening = await openForTest(
      buildFakeStdioServerSettings("fake", { failToolList: true }),
      context
    )

    expect(opening).toEqual({
      status: "failed",
      reason: "protocol-error",
      failure: { kind: "refused", message: "no tools today" },
      unknownError: undefined
    })
    expect(events.closedCount).toBe(0)
  })

  it("reports an answer that is not JSON as a protocol error", async () => {
    const server = await startFakeMcpHttpServer(answerWithInvalidJson())
    const { context } = createRecordingContext()

    const opening = await openForTest(
      buildHttpServerSettings("remote", server.url),
      context
    )

    expect(opening).toEqual({
      status: "failed",
      reason: "protocol-error",
      failure: { kind: "invalid-answer" },
      unknownError: undefined
    })
  })

  it("reports an answer longer than the response limit as a protocol error", async () => {
    const server = await startFakeMcpHttpServer((_request, body, response) => {
      const message = JSON.parse(body) as { id: number }
      response.writeHead(200, { "content-type": "application/json" })
      response.end(
        buildSizedTextResult(message.id, MAXIMUM_MCP_RESPONSE_BYTES + 1)
      )
    })
    const { context } = createRecordingContext()

    const opening = await openForTest(
      buildHttpServerSettings("remote", server.url),
      context
    )

    expect(opening).toEqual({
      status: "failed",
      reason: "protocol-error",
      failure: { kind: "too-large" },
      unknownError: undefined
    })
  })

  it.each(["initialize", "tools/list"])(
    "reports an event stream answer to %s that passes the response limit as a protocol error at once",
    async (method) => {
      const answerOther = answerAsMcpServer()
      const server = await startFakeMcpHttpServer((request, body, response) => {
        const message =
          request.method === "POST"
            ? (JSON.parse(body) as { method?: string })
            : {}
        if (message.method !== method) {
          answerOther(request, body, response)
          return
        }
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "mcp-session-id": "test-session"
        })
        response.write(`data: ${"x".repeat(MAXIMUM_MCP_RESPONSE_BYTES)}`)
      })
      const { context } = createRecordingContext()

      const opening = await openForTest(
        buildHttpServerSettings("remote", server.url),
        context,
        TOO_LARGE_STREAM_OPENING_TIMEOUT_MILLISECONDS
      )

      expect(opening).toEqual({
        status: "failed",
        reason: "protocol-error",
        failure: { kind: "too-large" },
        unknownError: undefined
      })
    }
  )

  it("reports a server that does not answer within the limit as timed out and stops it", async () => {
    const { context, events } = createRecordingContext()

    const opening = await openForTest(SILENT_SERVER_SETTINGS, context, 300)
    const pid = await waitForReportedPid(events)

    expect(opening).toEqual({
      status: "failed",
      reason: "timed-out",
      failure: { kind: "timed-out" },
      unknownError: undefined
    })
    await vi.waitFor(
      () => expect(isProcessRunning(pid)).toBe(false),
      EVENT_WAIT
    )
  })

  it("closes a connected server whose tool list does not arrive within the limit", async () => {
    const { context, events } = createRecordingContext()

    const opening = await openForTest(
      HANDSHAKE_ONLY_SERVER_SETTINGS,
      context,
      300
    )
    const pid = await waitForReportedPid(events)

    expect(opening).toEqual({
      status: "failed",
      reason: "timed-out",
      failure: { kind: "timed-out" },
      unknownError: undefined
    })
    await vi.waitFor(
      () => expect(isProcessRunning(pid)).toBe(false),
      EVENT_WAIT
    )
    expect(events.closedCount).toBe(0)
  })

  it("returns cancelled once the caller aborts, and stops the server it started", async () => {
    const controller = new AbortController()
    onTestFinished(() => controller.abort())
    const { context, events } = createRecordingContext(controller.signal)
    const pending = openForTest(SILENT_SERVER_SETTINGS, context)
    const pid = await waitForReportedPid(events)

    controller.abort(new Error("The settings changed"))

    expect(await pending).toEqual({ status: "cancelled" })
    await vi.waitFor(
      () => expect(isProcessRunning(pid)).toBe(false),
      EVENT_WAIT
    )
  })

  it("returns cancelled for a signal aborted before the opening", async () => {
    const controller = new AbortController()
    controller.abort(new Error("Already stopped"))
    const { context } = createRecordingContext(controller.signal)

    expect(
      await openForTest(buildFakeStdioServerSettings("fake"), context)
    ).toEqual({ status: "cancelled" })
  })
})
