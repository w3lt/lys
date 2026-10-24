import type { JsonValue, McpServerSettings } from "@lys/share"
import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type Tool,
  type Transport
} from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { version as LYS_VERSION } from "../../../package.json"
import { classifyMcpRequestFailure, isSpawnFailure } from "./mcpError"
import {
  fetchMcpResponse,
  MAXIMUM_MCP_RESPONSE_BYTES
} from "./mcpResponseLimit"
import McpServerLogLines from "./mcpServerLogLines"

/** Arguments of one call, by argument name, as the backend checked them. */
export type McpToolCallArguments = Readonly<Record<string, JsonValue>>

/** What opening one server's connection borrows from its opener. */
export type McpServerConnectionContext = Readonly<{
  /** Folder a stdio server starts in, such as the person's home folder. */
  workingDirectory: string
  /** Stops the opening and closes what it started; borrowed for the opening. */
  abortSignal: AbortSignal
  /** Receives each line a stdio server writes to its standard error, cut to a bound. */
  reportServerLogLine: (line: string) => void
  /**
   * Told at most once, after the handshake, when the connection ends without
   * {@link McpServerConnection.close}: the process exits, the transport
   * closes, or the server answers a call with HTTP 404, which ends a
   * Streamable HTTP session.
   */
  reportConnectionClosed: () => void
  /**
   * Receives a failure the SDK reports outside any request, such as a bad
   * message; never a failure to start the command, which the opening
   * reports, because Node's error for it holds the command's arguments.
   */
  reportConnectionError: (error: Error) => void
}>

/**
 * Most pages of a server's tool list the backend reads; a longer list fails
 * the opening.
 */
const MAXIMUM_TOOL_LIST_PAGES = 16

/** Longest a tool call may take before it fails, in milliseconds. */
export const MCP_TOOL_CALL_TIMEOUT_MILLISECONDS = 5 * 60 * 1000

/**
 * Longest opening a server may take, from the start of its process or
 * session to the end of its tool list, in milliseconds.
 *
 * @remarks Long enough for a command such as `npx` that downloads the
 * server before it starts. Each request of the opening has the same limit.
 */
export const MCP_SERVER_OPENING_TIMEOUT_MILLISECONDS = 2 * 60 * 1000

/** Lys as it introduces itself to every MCP server. */
const LYS_CLIENT_INFO = Object.freeze({ name: "lys", version: LYS_VERSION })

/**
 * Owns the connection to one MCP server: the SDK client and the transport it
 * talks through, which is a process Lys started or an HTTP session.
 *
 * @remarks Created by {@link McpServerConnection.open}, which finishes the
 * MCP handshake before it returns, so a connection is ready to list and call
 * tools. Closing ends the session and, for stdio, the process; it is
 * idempotent. When the connection ends by itself, the context's
 * `reportConnectionClosed` is told once; calls in flight then fail. An HTTP
 * 404 answer to a call counts as such an end, because the server no longer
 * knows the session, though the SDK keeps its transport open. Resource
 * ownership: owns the client and its transport until {@link close}.
 * Concurrency model: concurrent; the SDK client matches each answer to its
 * request, so calls and the tool list may overlap, and closing ends them
 * all.
 */
export default class McpServerConnection {
  /** SDK client that owns the transport. */
  readonly #client: Client
  /** Reporter of an end Lys did not ask for, borrowed from the opener. */
  readonly #reportConnectionClosed: () => void
  /** Completion of the first close, shared by every later close. */
  #closing: Promise<void> | undefined
  /** Whether an end Lys did not ask for was reported. */
  #hasReportedEnd: boolean

  /**
   * Keeps a client that finished its handshake.
   *
   * @param client - Connected client; the connection takes ownership.
   * @param reportConnectionClosed - Reporter of an end Lys did not ask for;
   * borrowed.
   */
  private constructor(client: Client, reportConnectionClosed: () => void) {
    this.#client = client
    this.#reportConnectionClosed = reportConnectionClosed
    this.#closing = undefined
    this.#hasReportedEnd = false
  }

  /**
   * Starts or reaches one server and finishes the MCP handshake.
   *
   * @param settings - Validated settings of the server.
   * @param context - Working folder, cancellation, and the reporters of the
   * connection's later events; borrowed.
   * @returns A ready connection the caller owns and must close.
   * @throws The SDK's or the transport's failure, such as a spawn error, an
   * HTTP error, a closed connection, or a timeout. Once the context's signal
   * aborts, the SDK's request-timeout error, which is how the SDK reports a
   * cancelled request. Whatever was started is closed first.
   * @remarks The client negotiates the protocol version through
   * `initialize`, the SDK's `legacy` mode and its default today, named here
   * so a new SDK default cannot change it unseen: in the 2026-07-28 era the
   * SDK would read the tool list again after a header mismatch and check
   * results against output schemas, which {@link listTools} avoids.
   */
  public static async open(
    settings: McpServerSettings,
    context: McpServerConnectionContext
  ): Promise<McpServerConnection> {
    const client = new Client(LYS_CLIENT_INFO, {
      capabilities: {},
      listMaxPages: MAXIMUM_TOOL_LIST_PAGES,
      versionNegotiation: { mode: "legacy" }
    })
    client.onerror = (error) => {
      reportConnectionError(context, error)
    }
    try {
      await client.connect(createTransport(settings, context), {
        signal: context.abortSignal,
        timeout: MCP_SERVER_OPENING_TIMEOUT_MILLISECONDS
      })
    } catch (error) {
      await client.close()
      throw error
    }
    const connection = new McpServerConnection(
      client,
      context.reportConnectionClosed
    )
    client.onclose = () => {
      connection.#reportEnd()
    }
    return connection
  }

  /**
   * Reads the server's whole tool list.
   *
   * @param abortSignal - Stops the read; borrowed for it.
   * @returns Every tool, in the server's order, across at most 16 pages.
   * @throws The SDK's failure, such as a timeout, a JSON-RPC error, or a list
   * longer than 16 pages. Once the signal aborts, the SDK's request-timeout
   * error, which is how the SDK reports a cancelled request.
   * @remarks The list bypasses the SDK's response cache, so the SDK holds no
   * tool's output schema and {@link callTool} never checks a result against
   * one. The SDK would compile such a schema and run its `pattern` keywords
   * on the backend's event loop, where one pattern a server chose could
   * block the backend for minutes. Lys treats a result's structured content
   * as untrusted JSON under its own limits instead.
   */
  public async listTools(abortSignal: AbortSignal): Promise<readonly Tool[]> {
    const result = await this.#client.listTools(undefined, {
      signal: abortSignal,
      timeout: MCP_SERVER_OPENING_TIMEOUT_MILLISECONDS,
      cacheMode: "bypass"
    })
    return result.tools
  }

  /**
   * Calls one tool of the server.
   *
   * @param serverToolName - Name the server calls the tool by.
   * @param callArguments - Arguments whose shape the backend checked.
   * @param abortSignal - Stops the call; the server is told it was
   * cancelled. Borrowed for the call.
   * @returns The server's result, which may report a failure of the tool
   * through `isError`. Its structured content is not checked against the
   * tool's output schema; see {@link listTools}.
   * @throws The SDK's failure, such as a timeout after
   * {@link MCP_TOOL_CALL_TIMEOUT_MILLISECONDS}, a closed connection, an HTTP
   * error, or a JSON-RPC error. Once the signal aborts, the SDK's
   * request-timeout error, which is how the SDK reports a cancelled request.
   * An HTTP 404 answer is also reported as an ended connection first.
   */
  public async callTool(
    serverToolName: string,
    callArguments: McpToolCallArguments,
    abortSignal: AbortSignal
  ): Promise<CallToolResult> {
    try {
      return await this.#client.callTool(
        { name: serverToolName, arguments: callArguments },
        { signal: abortSignal, timeout: MCP_TOOL_CALL_TIMEOUT_MILLISECONDS }
      )
    } catch (error) {
      if (isSessionEnded(error)) this.#reportEnd()
      throw error
    }
  }

  /**
   * Ends the session and, for stdio, the process.
   *
   * @returns A promise that settles once the transport closed; every later
   * call returns the same promise.
   * @remarks `reportConnectionClosed` is not told about a close asked for
   * here.
   */
  public close(): Promise<void> {
    this.#closing ??= this.#client.close()
    return this.#closing
  }

  /**
   * Reports an end Lys did not ask for, once, unless the connection is
   * closing.
   */
  #reportEnd(): void {
    if (this.#closing !== undefined || this.#hasReportedEnd) return
    this.#hasReportedEnd = true
    this.#reportConnectionClosed()
  }
}

/**
 * Tells whether a failed request shows that the server ended the session.
 *
 * @param error - What the request rejected with.
 * @returns Whether the server answered HTTP 404, which a Streamable HTTP
 * server sends for a session it no longer knows.
 */
function isSessionEnded(error: unknown): boolean {
  const failure = classifyMcpRequestFailure(error)
  return failure.kind === "http-status" && failure.status === 404
}

/**
 * Passes on a failure the SDK reports outside any request, unless it is the
 * command's failure to start, which the opening reports without its
 * arguments.
 *
 * @param context - Context whose reporter receives the failure.
 * @param error - Failure the SDK reported.
 */
function reportConnectionError(
  context: McpServerConnectionContext,
  error: Error
): void {
  if (!isSpawnFailure(error)) context.reportConnectionError(error)
}
/**
 * Creates the transport one server's settings name.
 *
 * @param settings - Validated server settings.
 * @param context - Working folder and the server log reporter.
 * @returns A stdio transport that starts the command in the working folder
 * with the SDK's default environment plus the configured variables, its
 * standard error read line by line; or a Streamable HTTP transport that
 * sends the configured headers and refuses redirects. Each reads at most
 * {@link MAXIMUM_MCP_RESPONSE_BYTES} of one answer: a longer stdio message
 * line ends the connection, and a longer HTTP body fails.
 */
function createTransport(
  settings: McpServerSettings,
  context: McpServerConnectionContext
): Transport {
  switch (settings.transport) {
    case "stdio": {
      const transport = new StdioClientTransport({
        command: settings.command,
        args: [...settings.arguments],
        env: Object.fromEntries(
          settings.environment.map((variable) => [
            variable.name,
            variable.value
          ])
        ),
        cwd: context.workingDirectory,
        stderr: "pipe",
        maxBufferSize: MAXIMUM_MCP_RESPONSE_BYTES
      })
      const logLines = new McpServerLogLines(context.reportServerLogLine)
      transport.stderr?.on("data", (chunk: Buffer) => logLines.read(chunk))
      return transport
    }
    case "http":
      return new StreamableHTTPClientTransport(new URL(settings.url), {
        fetch: fetchMcpResponse,
        requestInit: {
          headers: settings.headers.map((header) => [
            header.name,
            header.value
          ]),
          redirect: "manual"
        }
      })
  }
}
