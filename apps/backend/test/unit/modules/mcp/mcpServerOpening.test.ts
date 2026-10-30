import type { McpServerSettings } from "@lys/share"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import type { McpServerConnectionContext } from "../../../../src/modules/mcp/mcpServerConnection"
import { MAXIMUM_MCP_RESPONSE_BYTES } from "../../../../src/modules/mcp/mcpResponseLimit"
import {
  openMcpServer,
  type McpServerOpening
} from "../../../../src/modules/mcp/mcpServerOpening"
import type {
  McpHttpRoute,
  RecordedConnectionEvents
} from "../../support/mcpTestServers"
import {
  answerAsMcpServer,
  answerWithInvalidJson,
  answerWithStatus,
  answerWithToolListPages,
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
 * How long the slow-exit servers keep running after their standard input
 * ends, in milliseconds: well within the two seconds the SDK waits for a
 * process to exit, and long enough that a check made at once sees it run.
 */
const SLOW_EXIT_MILLISECONDS = 500

/**
 * Script of a stdio server that reports its process identifier, answers no
 * request, and exits {@link SLOW_EXIT_MILLISECONDS} after its standard
 * input ends.
 */
const SLOW_EXIT_SILENT_SERVER_SCRIPT = [
  'process.stderr.write("pid " + process.pid + "\\n")',
  "process.stdin.resume()",
  `process.stdin.on("end", () => setTimeout(() => process.exit(0), ${SLOW_EXIT_MILLISECONDS}))`
].join(";")

/**
 * Script of a stdio server that reports its process identifier, refuses
 * every request with a JSON-RPC error, the handshake included, and exits
 * {@link SLOW_EXIT_MILLISECONDS} after its standard input ends.
 */
const SLOW_EXIT_REFUSING_SERVER_SCRIPT = [
  'process.stderr.write("pid " + process.pid + "\\n")',
  'require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {',
  "  const message = JSON.parse(line)",
  "  if (message.id === undefined) return",
  '  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "not today" } }) + "\\n")',
  "})",
  `process.stdin.on("end", () => setTimeout(() => process.exit(0), ${SLOW_EXIT_MILLISECONDS}))`
].join("\n")

/**
 * Builds the settings of a stdio server run from an inline script.
 *
 * @param name - Server name.
 * @param script - Script Node runs.
 * @returns Validated-shape settings.
 */
function buildScriptServerSettings(
  name: string,
  script: string
): McpServerSettings {
  return Object.freeze({
    name,
    transport: "stdio",
    command: process.execPath,
    arguments: Object.freeze(["-e", script]),
    environment: Object.freeze([])
  })
}

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
 * Nesting depth of the input schema of {@link DEEP_SCHEMA_TOOL_TEXT}, deep
 * enough that the SDK's check of a tool runs out of stack.
 */
const DEEP_SCHEMA_DEPTH = 10_000

/**
 * Pieces of {@link DEEP_SCHEMA_TOOL_TEXT}: the tool's start, the start of
 * one nesting level, the innermost schema, the end of one level, and the
 * tool's end.
 */
const DEEP_SCHEMA_TOOL_PIECES = Object.freeze({
  start: '{"name":"deep","inputSchema":',
  levelStart: '{"type":"object","properties":{"a":',
  innermost: '{"type":"object"}',
  levelEnd: "}}",
  end: "}"
})

/**
 * JSON text of a tool whose input schema nests an object property
 * {@link DEEP_SCHEMA_DEPTH} levels deep, built as text because building it
 * as an object and serializing it would itself run out of stack.
 */
const DEEP_SCHEMA_TOOL_TEXT =
  DEEP_SCHEMA_TOOL_PIECES.start +
  DEEP_SCHEMA_TOOL_PIECES.levelStart.repeat(DEEP_SCHEMA_DEPTH) +
  DEEP_SCHEMA_TOOL_PIECES.innermost +
  DEEP_SCHEMA_TOOL_PIECES.levelEnd.repeat(DEEP_SCHEMA_DEPTH) +
  DEEP_SCHEMA_TOOL_PIECES.end

/** JSON text of a tool listed before the deep one, which stays usable. */
const SHALLOW_TOOL_TEXT = '{"name":"shallow","inputSchema":{"type":"object"}}'

/**
 * Script of a stdio server that answers the handshake and lists the tool
 * of JSON text {@link SHALLOW_TOOL_TEXT}, then the one of
 * {@link DEEP_SCHEMA_TOOL_TEXT}. The script builds the deep text from its
 * pieces, since the whole text is longer than Linux allows one
 * command-line argument to be.
 */
const DEEP_SCHEMA_STDIO_SERVER_SCRIPT = [
  `const pieces = ${JSON.stringify(DEEP_SCHEMA_TOOL_PIECES)}`,
  `const toolText = pieces.start + pieces.levelStart.repeat(${DEEP_SCHEMA_DEPTH}) + pieces.innermost + pieces.levelEnd.repeat(${DEEP_SCHEMA_DEPTH}) + pieces.end`,
  'require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {',
  "  const message = JSON.parse(line)",
  "  if (message.id === undefined) return",
  '  const head = \'{"jsonrpc":"2.0","id":\' + message.id + \',"result":\'',
  '  if (message.method === "initialize")',
  '    process.stdout.write(head + JSON.stringify({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "deep", version: "1.0.0" } }) + "}\\n")',
  '  else if (message.method === "tools/list")',
  `    process.stdout.write(head + '{"tools":[${SHALLOW_TOOL_TEXT},' + toolText + "]}}\\n")`,
  "})"
].join("\n")

/**
 * Builds a route that answers as {@link answerAsMcpServer} does, except
 * that it lists the tool of JSON text {@link SHALLOW_TOOL_TEXT}, then the
 * one of {@link DEEP_SCHEMA_TOOL_TEXT}.
 *
 * @returns The route.
 */
function answerWithDeepSchemaTool(): McpHttpRoute {
  const answerOther = answerAsMcpServer()
  return (request, body, response) => {
    const message =
      request.method === "POST"
        ? (JSON.parse(body) as { id?: number; method?: string })
        : {}
    if (message.method !== "tools/list") {
      answerOther(request, body, response)
      return
    }
    response.writeHead(200, {
      "content-type": "application/json",
      "mcp-session-id": "test-session"
    })
    response.end(
      `{"jsonrpc":"2.0","id":${String(message.id)},"result":{"tools":[${SHALLOW_TOOL_TEXT},${DEEP_SCHEMA_TOOL_TEXT}]}}`
    )
  }
}

/**
 * Builds a route that answers as {@link answerAsMcpServer} does, except
 * that it lists one tool per page of its tool list.
 *
 * @param pageCount - Pages of the list; page `n` lists the tool `tool<n>`
 * and names page `n + 1` as its next page, except the last.
 * @returns The route.
 */
function answerWithToolPages(pageCount: number): McpHttpRoute {
  const answerOther = answerAsMcpServer()
  return (request, body, response) => {
    const message =
      request.method === "POST"
        ? (JSON.parse(body) as {
            id?: number
            method?: string
            params?: { cursor?: string }
          })
        : {}
    if (message.method !== "tools/list") {
      answerOther(request, body, response)
      return
    }
    const page = Number(message.params?.cursor ?? "1")
    const nextCursor = page < pageCount ? String(page + 1) : undefined
    response.writeHead(200, {
      "content-type": "application/json",
      "mcp-session-id": "test-session"
    })
    response.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [{ name: `tool${page}`, inputSchema: { type: "object" } }],
          ...(nextCursor === undefined ? {} : { nextCursor })
        }
      })
    )
  }
}

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

  it("reads a tool list of 16 pages, the most the backend reads", async () => {
    const server = await startFakeMcpHttpServer(answerWithToolPages(16))
    const { context } = createRecordingContext()

    const opening = await openForTest(
      buildHttpServerSettings("remote", server.url),
      context
    )

    if (opening.status !== "connected")
      throw new Error("Expected the server to connect")
    expect(opening.catalog.definitions).toHaveLength(16)
    expect(opening.catalog.definitions.at(-1)?.name).toBe("mcp__remote__tool16")
  })

  it("fails a tool list of 17 pages as a protocol error after reading 16", async () => {
    const server = await startFakeMcpHttpServer(answerWithToolPages(17))
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
    expect(
      server.receivedRequests.filter(
        (request) => request.rpcMethod === "tools/list"
      )
    ).toHaveLength(16)
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

  it("reports HTTP 403 for a missing scope as unauthorized", async () => {
    const server = await startFakeMcpHttpServer(
      answerWithStatus(403, {
        "www-authenticate":
          'Bearer error="insufficient_scope", scope="tools:read"'
      })
    )
    const { context } = createRecordingContext()

    const opening = await openForTest(
      buildHttpServerSettings("remote", server.url),
      context
    )

    expect(opening).toEqual({
      status: "failed",
      reason: "unauthorized",
      failure: { kind: "http-status", status: 403 },
      unknownError: undefined
    })
  })

  it.each([
    [
      "an HTTP",
      async (): Promise<McpServerSettings> =>
        buildHttpServerSettings(
          "deep",
          (await startFakeMcpHttpServer(answerWithDeepSchemaTool())).url
        )
    ],
    [
      "a stdio",
      (): Promise<McpServerSettings> =>
        Promise.resolve(
          buildScriptServerSettings("deep", DEEP_SCHEMA_STDIO_SERVER_SCRIPT)
        )
    ]
  ])(
    "connects %s server whose tool list holds an input schema too deep for the SDK's check, skipping only that tool",
    async (_transport, buildSettings) => {
      const { context } = createRecordingContext()

      const opening = await openForTest(await buildSettings(), context)

      if (opening.status !== "connected")
        throw new Error("Expected the server to connect")
      expect(opening.catalog.definitions.map((tool) => tool.name)).toEqual([
        "mcp__deep__shallow"
      ])
      expect(opening.catalog.skippedTools).toEqual([
        { name: "deep", reason: "unsupported-input-schema" }
      ])
    }
  )

  it("stops reading a tool list at the first tool past the 128 the backend keeps", async () => {
    const tools = (first: number): unknown[] =>
      Array.from({ length: 100 }, (_tool, index) => ({
        name: `tool${String(first + index)}`,
        inputSchema: { type: "object" }
      }))
    const server = await startFakeMcpHttpServer(
      answerWithToolListPages({
        "": { tools: tools(1), nextCursor: "2" },
        "2": { tools: tools(101), nextCursor: "3" },
        "3": { tools: tools(201) }
      })
    )
    const { context } = createRecordingContext()

    const opening = await openForTest(
      buildHttpServerSettings("remote", server.url),
      context
    )

    if (opening.status !== "connected")
      throw new Error("Expected the server to connect")
    expect(opening.catalog.definitions).toHaveLength(128)
    expect(opening.catalog.definitions.at(-1)?.name).toBe(
      "mcp__remote__tool128"
    )
    expect(opening.catalog.isToolListCut).toBe(true)
    expect(
      server.receivedRequests.filter(
        (request) => request.rpcMethod === "tools/list"
      )
    ).toHaveLength(2)
  })

  it("keeps the tools of a page that names the cursor it was asked with, and ends the list once that page comes back the same", async () => {
    const server = await startFakeMcpHttpServer(
      answerWithToolListPages({
        "": {
          tools: [{ name: "first", inputSchema: { type: "object" } }],
          nextCursor: "again"
        },
        again: {
          tools: [{ name: "repeated", inputSchema: { type: "object" } }],
          nextCursor: "again"
        }
      })
    )
    const { context } = createRecordingContext()

    const opening = await openForTest(
      buildHttpServerSettings("remote", server.url),
      context
    )

    if (opening.status !== "connected")
      throw new Error("Expected the server to connect")
    expect(opening.catalog.definitions.map((tool) => tool.name)).toEqual([
      "mcp__remote__first",
      "mcp__remote__repeated"
    ])
    expect(opening.catalog.isToolListCut).toBe(false)
    expect(
      server.receivedRequests.filter(
        (request) => request.rpcMethod === "tools/list"
      )
    ).toHaveLength(3)
  })

  it("fails a tool list holding a tool the MCP tool schema refuses as a protocol error", async () => {
    const server = await startFakeMcpHttpServer(
      answerAsMcpServer([{ name: "no-schema" }])
    )
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

  it("settles a handshake cancelled by the caller only after the server's process has ended", async () => {
    const controller = new AbortController()
    onTestFinished(() => controller.abort())
    const { context, events } = createRecordingContext(controller.signal)
    const pending = openForTest(
      buildScriptServerSettings("slow-exit", SLOW_EXIT_SILENT_SERVER_SCRIPT),
      context
    )
    const pid = await waitForReportedPid(events)

    controller.abort(new Error("The person pressed Restart"))
    const opening = await pending

    expect(opening).toEqual({ status: "cancelled" })
    expect(isProcessRunning(pid)).toBe(false)
  })

  it("settles a handshake that timed out only after the server's process has ended", async () => {
    const { context, events } = createRecordingContext()
    const pending = openForTest(
      buildScriptServerSettings("slow-exit", SLOW_EXIT_SILENT_SERVER_SCRIPT),
      context,
      300
    )
    const pid = await waitForReportedPid(events)

    const opening = await pending

    expect(opening).toEqual({
      status: "failed",
      reason: "timed-out",
      failure: { kind: "timed-out" },
      unknownError: undefined
    })
    expect(isProcessRunning(pid)).toBe(false)
  })

  it("settles a refused handshake only after the server's process has ended", async () => {
    const { context, events } = createRecordingContext()
    const pending = openForTest(
      buildScriptServerSettings("slow-exit", SLOW_EXIT_REFUSING_SERVER_SCRIPT),
      context
    )
    const pid = await waitForReportedPid(events)

    const opening = await pending

    expect(opening).toEqual({
      status: "failed",
      reason: "protocol-error",
      failure: { kind: "refused", message: "not today" },
      unknownError: undefined
    })
    expect(isProcessRunning(pid)).toBe(false)
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
