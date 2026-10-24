import type { McpServerFailure, McpServerState } from "@lys/protocol"
import type { McpServerSettings, McpToolDefinition } from "@lys/share"
import { classifyMcpRequestFailure } from "./mcpError"
import type McpServerConnection from "./mcpServerConnection"
import type {
  McpServerConnectionContext,
  McpToolCallArguments
} from "./mcpServerConnection"
import type { McpServerEvent } from "./mcpServerEvent"
import type { McpServerOpening } from "./mcpServerOpening"
import type { McpToolCatalog } from "./mcpToolCatalog"
import {
  formatMcpServerNotConnected,
  formatMcpToolCallFailure,
  formatMcpToolNoLongerListed,
  formatMcpToolResult,
  type McpToolCallOutcome,
  type McpToolCallSubject
} from "./mcpToolResult"

/** What a session borrows for its lifetime. */
export type McpServerSessionDependencies = Readonly<{
  /**
   * Opens one server and reads its tools; never rejects for an expected
   * failure. Production passes `openMcpServer` with its time limit.
   */
  openServer: (
    settings: McpServerSettings,
    context: McpServerConnectionContext
  ) => Promise<McpServerOpening>
  /** Folder a stdio server starts in, such as the person's home folder. */
  workingDirectory: string
  /** Receives every {@link McpServerEvent} of the session. */
  reportEvent: (event: McpServerEvent) => void
  /**
   * Keeps one background close, which never rejects, until it settles, so
   * its owner can wait for it.
   */
  trackTask: (task: Promise<void>) => void
}>

/** Outcome of looking up one tool in a session. */
export type McpSessionToolLookup =
  | Readonly<{
      /** The server is connected and lists the tool. */
      status: "found"
      /** The tool's definition. */
      definition: McpToolDefinition
    }>
  | Readonly<{
      /** The server is connecting or failed. */
      status: "not-connected"
    }>
  | Readonly<{
      /** The connected server does not list a tool by that name. */
      status: "unknown"
    }>

/** State of a session. */
type SessionState =
  | Readonly<{
      /** The server is being opened. */
      status: "connecting"
    }>
  | Readonly<{
      /** The server is connected. */
      status: "connected"
      /** The open connection the session owns. */
      connection: McpServerConnection
      /** Its tools. */
      catalog: McpToolCatalog
      /** Its listed tools by model-facing name. */
      toolsByName: ReadonlyMap<string, McpToolDefinition>
    }>
  | Readonly<{
      /** The server is not connected. */
      status: "failed"
      /** Why. */
      reason: McpServerFailure
    }>

/** State of a session whose connection ended by itself. */
const CLOSED_STATE: SessionState = Object.freeze({
  status: "failed",
  reason: "closed"
})

/** Failure when Lys could not tell why opening a server failed. */
const PROTOCOL_ERROR: McpServerFailure = "protocol-error"

/** Lookup of a session whose server is not connected. */
const NOT_CONNECTED_LOOKUP: McpSessionToolLookup = Object.freeze({
  status: "not-connected"
})

/** Lookup of a tool the connected server does not list. */
const UNKNOWN_TOOL_LOOKUP: McpSessionToolLookup = Object.freeze({
  status: "unknown"
})

/**
 * One attempt to open an MCP server, and the connection it leads to.
 *
 * @remarks Lifecycle: {@link open} runs once and ends connected, failed, or
 * cancelled; {@link stop} ends the session for good, cancelling its opening
 * or closing its connection. A connection that ends by itself fails the
 * session as `closed`; a session never reconnects, its owner starts a new
 * one. Resource ownership: owns the connection its opening led to until it
 * closes it; a connection an opening returns after {@link stop} is closed
 * at once. Every close runs in the background through `trackTask`.
 * Concurrency model: single-threaded; every state change happens
 * synchronously, so a reader always sees one consistent state.
 */
export default class McpServerSession {
  /** Validated settings the session opens. */
  readonly #settings: McpServerSettings
  /** Borrowed opener, working folder, reporter, and task tracker. */
  readonly #dependencies: McpServerSessionDependencies
  /** Cancels the opening. */
  readonly #controller: AbortController
  /** Current state. */
  #state: SessionState
  /** Whether {@link stop} was called. */
  #isStopped: boolean
  /** Whether the opening's connection ended by itself. */
  #hasConnectionEnded: boolean

  /**
   * Creates a session that is connecting.
   *
   * @param settings - Validated settings of the server.
   * @param dependencies - Opener, working folder, reporter, and task
   * tracker, borrowed for the session's lifetime.
   * @remarks Starts and contacts nothing; {@link open} does.
   */
  public constructor(
    settings: McpServerSettings,
    dependencies: McpServerSessionDependencies
  ) {
    this.#settings = settings
    this.#dependencies = dependencies
    this.#controller = new AbortController()
    this.#state = Object.freeze({ status: "connecting" })
    this.#isStopped = false
    this.#hasConnectionEnded = false
  }

  /**
   * The state the server list reports, without the connection.
   *
   * @returns A frozen state.
   */
  public get state(): McpServerState {
    switch (this.#state.status) {
      case "connecting":
        return Object.freeze({ status: "connecting" })
      case "connected":
        return Object.freeze({
          status: "connected",
          toolCount: this.#state.catalog.definitions.length,
          skippedTools: this.#state.catalog.skippedTools,
          isToolListCut: this.#state.catalog.isToolListCut
        })
      case "failed":
        return Object.freeze({ status: "failed", reason: this.#state.reason })
    }
  }

  /**
   * Opens the server and reads its tools.
   *
   * @returns A promise that settles once the opening ended; it never
   * rejects. Call it once.
   * @remarks An opener that throws fails the session as `protocol-error`,
   * keeping what was thrown for the log.
   */
  public async open(): Promise<void> {
    const serverName = this.#settings.name
    const { reportEvent } = this.#dependencies
    let opening: McpServerOpening
    try {
      opening = await this.#dependencies.openServer(this.#settings, {
        workingDirectory: this.#dependencies.workingDirectory,
        abortSignal: this.#controller.signal,
        reportServerLogLine: (line) =>
          reportEvent({ kind: "server-log-line", serverName, line }),
        reportConnectionClosed: () => this.#handleConnectionEnded(),
        reportConnectionError: (error) =>
          reportEvent({ kind: "connection-error", serverName, error })
      })
    } catch (error) {
      opening = Object.freeze({
        status: "failed",
        reason: PROTOCOL_ERROR,
        failure: classifyMcpRequestFailure(error),
        unknownError: error
      })
    }
    this.#finishOpening(opening)
  }

  /**
   * Lists the tools of the connected server.
   *
   * @returns Its listed tools in its order; empty unless connected.
   */
  public listToolDefinitions(): readonly McpToolDefinition[] {
    return this.#state.status === "connected"
      ? this.#state.catalog.definitions
      : []
  }

  /**
   * Finds one listed tool by its model-facing name.
   *
   * @param toolName - Model-facing name, such as `mcp__files__read`.
   * @returns `found` with its definition, `not-connected` unless the server
   * is connected, or `unknown`.
   */
  public findTool(toolName: string): McpSessionToolLookup {
    if (this.#state.status !== "connected") return NOT_CONNECTED_LOOKUP
    const definition = this.#state.toolsByName.get(toolName)
    return definition === undefined
      ? UNKNOWN_TOOL_LOOKUP
      : Object.freeze({ status: "found", definition })
  }

  /**
   * Runs one call of a tool on the server as connected now.
   *
   * @param definition - The tool, as it was offered.
   * @param callArguments - Arguments whose shape the backend checked.
   * @param abortSignal - Stops the call; the server is told it was
   * cancelled.
   * @returns The server's result; or a failed outcome when the server is not
   * connected, no longer lists the tool under the same server name, or the
   * request failed, which is also reported.
   * @throws Only once the signal aborted.
   */
  public async callTool(
    definition: McpToolDefinition,
    callArguments: McpToolCallArguments,
    abortSignal: AbortSignal
  ): Promise<McpToolCallOutcome> {
    const subject = buildCallSubject(definition)
    if (this.#state.status !== "connected")
      return buildFailedOutcome(formatMcpServerNotConnected(subject))
    const listed = this.#state.toolsByName.get(definition.name)
    if (listed?.serverToolName !== definition.serverToolName)
      return buildFailedOutcome(formatMcpToolNoLongerListed(subject))
    try {
      const result = await this.#state.connection.callTool(
        definition.serverToolName,
        callArguments,
        abortSignal
      )
      return formatMcpToolResult(subject, result)
    } catch (error) {
      if (abortSignal.aborted) throw error
      const failure = classifyMcpRequestFailure(error)
      this.#dependencies.reportEvent({
        kind: "tool-call-failed",
        serverName: definition.server,
        serverToolName: definition.serverToolName,
        failure,
        unknownError: failure.kind === "unknown" ? error : undefined
      })
      return buildFailedOutcome(formatMcpToolCallFailure(subject, failure))
    }
  }

  /**
   * Ends the session: cancels its opening or closes its connection.
   *
   * @remarks Idempotent. The state stays as it was; the owner forgets the
   * session.
   */
  public stop(): void {
    if (this.#isStopped) return
    this.#isStopped = true
    if (this.#state.status === "connecting") this.#controller.abort()
    else if (this.#state.status === "connected")
      this.#closeConnection(this.#state.connection)
  }

  /**
   * Records how the opening ended.
   *
   * @param opening - How it ended.
   * @remarks A connection that arrives after {@link stop} is closed. A
   * connection that ended while its tools were read fails as `closed`.
   */
  #finishOpening(opening: McpServerOpening): void {
    if (this.#isStopped) {
      if (opening.status === "connected")
        this.#closeConnection(opening.connection)
      return
    }
    switch (opening.status) {
      case "cancelled":
        return
      case "failed":
        this.#dependencies.reportEvent({
          kind: "opening-failed",
          serverName: this.#settings.name,
          reason: opening.reason,
          failure: opening.failure,
          unknownError: opening.unknownError
        })
        this.#state = Object.freeze({
          status: "failed",
          reason: opening.reason
        })
        return
      case "connected":
        this.#finishConnectedOpening(opening)
        return
    }
  }

  /**
   * Records an opening that connected.
   *
   * @param opening - The connected opening.
   */
  #finishConnectedOpening(
    opening: Extract<McpServerOpening, { status: "connected" }>
  ): void {
    const serverName = this.#settings.name
    if (this.#hasConnectionEnded) {
      this.#closeConnection(opening.connection)
      this.#dependencies.reportEvent({ kind: "connection-closed", serverName })
      this.#state = CLOSED_STATE
      return
    }
    const { catalog } = opening
    this.#dependencies.reportEvent({
      kind: "connected",
      serverName,
      toolCount: catalog.definitions.length,
      skippedToolCount: catalog.skippedTools.length,
      isToolListCut: catalog.isToolListCut
    })
    this.#state = Object.freeze({
      status: "connected",
      connection: opening.connection,
      catalog,
      toolsByName: new Map(
        catalog.definitions.map((definition) => [definition.name, definition])
      )
    })
  }

  /**
   * Handles the connection ending by itself.
   *
   * @remarks A connected session that was not stopped fails as `closed`; an
   * opening still reading tools fails when it ends.
   */
  #handleConnectionEnded(): void {
    this.#hasConnectionEnded = true
    if (this.#isStopped || this.#state.status !== "connected") return
    this.#closeConnection(this.#state.connection)
    this.#dependencies.reportEvent({
      kind: "connection-closed",
      serverName: this.#settings.name
    })
    this.#state = CLOSED_STATE
  }

  /**
   * Closes one connection in the background, reporting a failed close.
   *
   * @param connection - Connection the session no longer keeps.
   */
  #closeConnection(connection: McpServerConnection): void {
    const serverName = this.#settings.name
    this.#dependencies.trackTask(
      connection.close().then(undefined, (error: unknown) => {
        this.#dependencies.reportEvent({
          kind: "close-failed",
          serverName,
          error
        })
      })
    )
  }
}

/**
 * Builds the subject of one call.
 *
 * @param definition - The called tool.
 * @returns A frozen subject naming the server and the name the model calls
 * the tool by.
 */
function buildCallSubject(definition: McpToolDefinition): McpToolCallSubject {
  return Object.freeze({
    serverName: definition.server,
    toolName: definition.name
  })
}

/**
 * Builds the outcome of a call that failed before it reached the server.
 *
 * @param content - Why, for the model.
 * @returns A frozen `failed` outcome.
 */
function buildFailedOutcome(content: string): McpToolCallOutcome {
  return Object.freeze({ status: "failed", content })
}

/**
 * Builds the outcome of a call whose server is not applied any more.
 *
 * @param definition - The called tool.
 * @returns A frozen `failed` outcome saying the server is not connected.
 */
export function buildServerNotConnectedOutcome(
  definition: McpToolDefinition
): McpToolCallOutcome {
  return buildFailedOutcome(
    formatMcpServerNotConnected(buildCallSubject(definition))
  )
}
