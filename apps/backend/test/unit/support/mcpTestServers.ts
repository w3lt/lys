import type {
  McpEnvironmentVariable,
  McpHeader,
  McpServerSettings
} from "@lys/share"
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http"
import { fileURLToPath } from "node:url"
import { onTestFinished } from "vitest"
import type { McpServerConnectionContext } from "../../../src/modules/mcp/mcpServerConnection"

/** Options the fake stdio server reads from its first argument. */
export type FakeStdioServerOptions = Readonly<{
  /** Tools it lists; one `echo` tool when omitted. */
  tools?: readonly unknown[]
  /** Exit with this code right after starting. */
  exitOnStart?: number
  /** Answer the tool list with a JSON-RPC error. */
  failToolList?: boolean
  /** Write the working folder and these variables to standard error. */
  reportEnvironment?: readonly string[]
  /** Write the process identifier to standard error as `pid <id>`. */
  reportProcessId?: boolean
  /**
   * Hold this file while running, as a server that runs one copy at a time:
   * create it on start, or exit with code 3 when it exists, and remove it on
   * exit.
   */
  lockFile?: string
  /** Wait this long after standard input closes before exiting. */
  shutdownDelayMilliseconds?: number
}>

/** One request the fake HTTP server received. */
export type ReceivedMcpHttpRequest = Readonly<{
  /** HTTP method. */
  method: string
  /** Request headers, lowercased by Node. */
  headers: IncomingHttpHeaders
  /** JSON-RPC method of a POST, if any. */
  rpcMethod: string | undefined
}>

/** Answers one request the fake HTTP server received, after its body was read. */
export type McpHttpRoute = (
  request: IncomingMessage,
  body: string,
  response: ServerResponse
) => void

/** Local server standing in for a remote MCP server. */
export type FakeMcpHttpServer = Readonly<{
  /** URL of its MCP endpoint, such as `http://127.0.0.1:50123/mcp`. */
  url: string
  /** Every request the server received, in arrival order. */
  receivedRequests: readonly ReceivedMcpHttpRequest[]
}>

/** What a test's connection context recorded. */
export type RecordedConnectionEvents = {
  /** Lines the server wrote to standard error. */
  readonly logLines: string[]
  /** How often the connection ended by itself. */
  closedCount: number
  /** Errors the SDK reported outside any request. */
  readonly errors: Error[]
}

/** Path of the fake stdio server script. */
const FAKE_STDIO_SERVER_PATH = fileURLToPath(
  new URL("./fakeMcpStdioServer.ts", import.meta.url)
)

/** Tool the fake servers list by default. */
export const ECHO_TOOL = Object.freeze({
  name: "echo",
  description: "Echoes its arguments.",
  inputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({ text: Object.freeze({ type: "string" }) }),
    required: Object.freeze(["text"])
  })
})

/**
 * Builds the settings of a server that runs the fake stdio server with Node.
 *
 * @param name - Server name.
 * @param options - What the fake server does.
 * @param environment - Variables the server is started with.
 * @returns Validated-shape settings.
 */
export function buildFakeStdioServerSettings(
  name: string,
  options: FakeStdioServerOptions = {},
  environment: readonly McpEnvironmentVariable[] = []
): McpServerSettings {
  return Object.freeze({
    name,
    transport: "stdio",
    command: process.execPath,
    arguments: Object.freeze([
      "--no-warnings",
      FAKE_STDIO_SERVER_PATH,
      JSON.stringify(options)
    ]),
    environment: Object.freeze(environment.map((entry) => Object.freeze(entry)))
  })
}

/**
 * Builds the settings of a server reached over HTTP.
 *
 * @param name - Server name.
 * @param url - Endpoint URL.
 * @param headers - Headers sent with every request.
 * @returns Validated-shape settings.
 */
export function buildHttpServerSettings(
  name: string,
  url: string,
  headers: readonly McpHeader[] = []
): McpServerSettings {
  return Object.freeze({
    name,
    transport: "http",
    url,
    headers: Object.freeze(headers.map((header) => Object.freeze(header)))
  })
}

/**
 * Builds a connection context that records what the connection reports.
 *
 * @param abortSignal - Cancels the opening; never aborted when omitted.
 * @returns The context, and what it recorded.
 */
export function createRecordingContext(
  abortSignal: AbortSignal = new AbortController().signal
): {
  context: McpServerConnectionContext
  events: RecordedConnectionEvents
} {
  const events: RecordedConnectionEvents = {
    logLines: [],
    closedCount: 0,
    errors: []
  }
  return {
    events,
    context: {
      workingDirectory: process.cwd(),
      abortSignal,
      reportServerLogLine: (line) => events.logLines.push(line),
      reportConnectionClosed: () => {
        events.closedCount += 1
      },
      reportConnectionError: (error) => events.errors.push(error)
    }
  }
}

/**
 * Gets the TCP port a listening server is bound to.
 *
 * @param server - HTTP server.
 * @returns The port.
 * @throws When the server does not listen on a TCP port.
 */
function getServerPort(server: Server): number {
  const address = server.address()
  if (address === null || typeof address === "string")
    throw new Error("The test server does not listen on a TCP port")
  return address.port
}

/**
 * Reads a request's body as text.
 *
 * @param request - Incoming request.
 * @returns Its body.
 */
async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf8")
}

/**
 * Reads the JSON-RPC method of a body, if it has one.
 *
 * @param body - Request body.
 * @returns The method, or undefined.
 */
function readRpcMethod(body: string): string | undefined {
  try {
    const message: unknown = JSON.parse(body)
    return typeof message === "object" &&
      message !== null &&
      "method" in message &&
      typeof message.method === "string"
      ? message.method
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Starts a fake MCP server on a free loopback port, closed with its
 * connections when the current test finishes.
 *
 * @param route - Answers each request; {@link answerAsMcpServer} when
 * omitted.
 * @returns The server's endpoint URL and the requests it receives.
 */
export async function startFakeMcpHttpServer(
  route: McpHttpRoute = answerAsMcpServer()
): Promise<FakeMcpHttpServer> {
  const receivedRequests: ReceivedMcpHttpRequest[] = []
  const server = createServer((request, response) => {
    void readBody(request).then((body) => {
      receivedRequests.push(
        Object.freeze({
          method: request.method ?? "",
          headers: request.headers,
          rpcMethod: readRpcMethod(body)
        })
      )
      route(request, body, response)
    })
  })
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return Object.freeze({
    url: `http://127.0.0.1:${getServerPort(server)}/mcp`,
    receivedRequests
  })
}

/**
 * Finds a URL on a loopback port nothing listens on.
 *
 * @returns The URL of a port a server listened on and then closed.
 */
export async function findClosedMcpUrl(): Promise<string> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    return `http://127.0.0.1:${getServerPort(server)}/mcp`
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

/**
 * Builds a route that answers as a Streamable HTTP MCP server that replies
 * with JSON.
 *
 * @param tools - Tools it lists; {@link ECHO_TOOL} when omitted.
 * @returns The route: `initialize` starts a session, `tools/list` lists the
 * tools, `tools/call` echoes the arguments, a notification is accepted, and
 * any other method is refused.
 */
export function answerAsMcpServer(
  tools: readonly unknown[] = [ECHO_TOOL]
): McpHttpRoute {
  return (request, body, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end()
      return
    }
    const message = JSON.parse(body) as {
      id?: number
      method: string
      params?: Record<string, unknown>
    }
    if (message.id === undefined) {
      response.writeHead(202).end()
      return
    }
    const reply = (payload: Record<string, unknown>): void => {
      response.writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": "test-session"
      })
      response.end(
        JSON.stringify({ jsonrpc: "2.0", id: message.id, ...payload })
      )
    }
    switch (message.method) {
      case "initialize":
        reply({
          result: {
            protocolVersion: message.params?.["protocolVersion"],
            capabilities: { tools: {} },
            serverInfo: { name: "fake-http", version: "1.0.0" }
          }
        })
        return
      case "tools/list":
        reply({ result: { tools } })
        return
      case "tools/call":
        reply({
          result: {
            content: [
              {
                type: "text",
                text: `echo: ${JSON.stringify(message.params?.["arguments"] ?? {})}`
              }
            ]
          }
        })
        return
      default:
        reply({ error: { code: -32601, message: "unknown method" } })
    }
  }
}

/**
 * Builds a route that answers as {@link answerAsMcpServer} does, except for
 * tool calls.
 *
 * @param answerCall - Answers each `tools/call` request, by its identifier.
 * @returns The route.
 */
export function answerToolCallsWith(
  answerCall: (id: number, response: ServerResponse) => void
): McpHttpRoute {
  const answerOther = answerAsMcpServer()
  return (request, body, response) => {
    const message =
      request.method === "POST"
        ? (JSON.parse(body) as { id?: number; method?: string })
        : {}
    if (message.method === "tools/call" && message.id !== undefined)
      answerCall(message.id, response)
    else answerOther(request, body, response)
  }
}

/**
 * Builds the JSON-RPC answer to one request: a text result whose JSON text
 * has exactly the given number of UTF-8 bytes.
 *
 * @param id - Request identifier.
 * @param byteLength - Bytes of the answer, at least those of an empty text
 * result.
 * @returns The answer's JSON text.
 */
export function buildSizedTextResult(id: number, byteLength: number): string {
  const empty = {
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text: "" }] }
  }
  const text = "x".repeat(byteLength - Buffer.byteLength(JSON.stringify(empty)))
  return JSON.stringify({
    ...empty,
    result: { content: [{ type: "text", text }] }
  })
}

/**
 * Builds a route that answers every request with one status.
 *
 * @param status - HTTP status.
 * @param headers - Headers of the answer.
 * @returns The route.
 */
export function answerWithStatus(
  status: number,
  headers: Readonly<Record<string, string>> = {}
): McpHttpRoute {
  return (_request, _body, response) => {
    response.writeHead(status, headers).end("refused")
  }
}

/**
 * Builds a route that answers every request with text that is not JSON.
 *
 * @returns The route.
 */
export function answerWithInvalidJson(): McpHttpRoute {
  return (_request, _body, response) => {
    response.writeHead(200, { "content-type": "application/json" }).end("{no")
  }
}
