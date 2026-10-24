import type { McpServerList } from "@lys/protocol"
import {
  MCP_TOOL_NAME_PREFIX,
  type McpServerSettings,
  type McpToolDefinition
} from "@lys/share"
import { isDeepStrictEqual } from "node:util"
import type { McpSettingsRead } from "../../infrastructure/settings/mcpSettingsFile"
import type { McpToolCallArguments } from "./mcpServerConnection"
import McpServerSession, {
  buildServerNotConnectedOutcome,
  type McpServerSessionDependencies
} from "./mcpServerSession"
import type { McpToolCallOutcome } from "./mcpToolResult"

/**
 * What the registry borrows for its lifetime: the settings reader, and the
 * opener, working folder, and reporter every server's session borrows.
 */
export type McpServerRegistryDependencies = Readonly<{
  /** Reads the `mcp` group from the settings file again. */
  readSettings: () => Promise<McpSettingsRead>
}> &
  Omit<McpServerSessionDependencies, "trackTask">

/** One MCP tool found for a turn. */
export type TurnMcpTool = Readonly<{
  /** Definition offered to the model. */
  definition: McpToolDefinition
  /**
   * Runs one call on the tool's server as it is connected when the call
   * runs.
   *
   * @param callArguments - Arguments whose shape the backend checked.
   * @param abortSignal - Stops the call; the server is told it was
   * cancelled.
   * @returns The outcome the model reads: the server's result, or why the
   * call failed, such as the server not being connected any more.
   * @throws Only once the signal aborted.
   */
  callTool: (
    callArguments: McpToolCallArguments,
    abortSignal: AbortSignal
  ) => Promise<McpToolCallOutcome>
}>

/** Outcome of looking up one MCP tool a request offers. */
export type McpTurnToolLookup =
  | Readonly<{
      /** The tool's server is connected and lists it. */
      status: "found"
      /** The tool. */
      tool: TurnMcpTool
    }>
  | Readonly<{
      /** The tool's server is applied but not connected now. */
      status: "not-connected"
    }>
  | Readonly<{
      /** No applied server, or no connected server's tool, has the name. */
      status: "unknown"
    }>

/** Outcome of asking one server to connect again. */
export type McpServerReconnection = "reconnecting" | "not-found"

/** One applied server: the settings it was applied with and its session. */
type ServerEntry = Readonly<{
  /** Validated settings it was applied with. */
  settings: McpServerSettings
  /** The session that opens it now. */
  session: McpServerSession
}>

/** Outcome of the last read of the settings group. */
type SettingsStatus = McpServerList["settings"]

/** Lookup of a name no applied server has. */
const UNKNOWN_TOOL: McpTurnToolLookup = Object.freeze({ status: "unknown" })

/**
 * Owns the MCP servers the settings file names, one session each, for the
 * backend's lifetime.
 *
 * @remarks {@link applySettings} reads the `mcp` group and applies it: a
 * new or changed server gets a new session, an unchanged one keeps its
 * session, with its connection or failure, and a removed one's session is
 * stopped. Opening runs in the background; the list reports each server as
 * connecting until its opening ends. Nothing reconnects by itself:
 * {@link reconnect} or a changed setting starts a new session, which opens
 * only once the session it replaces released the server, so a command
 * server's old process has ended before its new one starts. Settings that
 * fail their rules or cannot be read keep the servers applied before.
 * Resource ownership: owns every session it started until it stops it; a
 * stopped session closes its connection, now or when its opening ends.
 * Concurrency model: single-threaded with background tasks; settings reads
 * run one after another in call order, each applied synchronously once
 * read, and every state change happens synchronously, so a lookup always
 * sees one consistent state. {@link close} is idempotent and waits for every
 * opening and close it started.
 */
export default class McpServerRegistry {
  /** Borrowed settings reader, opener, working folder, and reporter. */
  readonly #dependencies: McpServerRegistryDependencies
  /** Applied servers in the settings group's order. */
  #entries: Map<string, ServerEntry>
  /** Outcome of the last read of the settings group. */
  #settingsStatus: SettingsStatus
  /** Settles once every settings read asked for so far was applied. */
  #settingsReads: Promise<unknown>
  /** Openings and closes still running. */
  readonly #tasks: Set<Promise<void>>
  /** Whether {@link close} was called. */
  #isClosed: boolean

  /**
   * Creates a registry with no server.
   *
   * @param dependencies - Settings reader, opener, working folder, and
   * reporter, borrowed for the registry's lifetime.
   * @remarks Reads, starts, and contacts nothing.
   */
  public constructor(dependencies: McpServerRegistryDependencies) {
    this.#dependencies = dependencies
    this.#entries = new Map()
    this.#settingsStatus = "applied"
    this.#settingsReads = Promise.resolve()
    this.#tasks = new Set()
    this.#isClosed = false
  }

  /**
   * Reads the `mcp` settings group again and applies it.
   *
   * @returns A promise that settles once the group was read and applied;
   * the servers it opens are still connecting then.
   * @throws Only when closing the settings file fails.
   * @remarks Reads run one after another in call order. After
   * {@link close}, it reads nothing.
   */
  public applySettings(): Promise<void> {
    const applying = this.#settingsReads.then(() => this.#readAndApply())
    this.#settingsReads = Promise.allSettled([applying])
    return applying
  }

  /**
   * Stops one applied server's session and opens the server again in a new
   * one.
   *
   * @param serverName - Name of the server, compared exactly.
   * @returns `reconnecting` once the new session was started, or `not-found`
   * when no applied server has the name, which is always the case after
   * {@link close}.
   * @remarks The new session opens once the old one released the server.
   */
  public reconnect(serverName: string): McpServerReconnection {
    const entry = this.#entries.get(serverName)
    if (entry === undefined) return "not-found"
    this.#startSession(entry.settings, entry.session.stop())
    return "reconnecting"
  }

  /**
   * Lists the applied servers and their states.
   *
   * @returns A frozen list in the settings group's order, with the outcome
   * of the last settings read; it carries no setting.
   */
  public listServers(): McpServerList {
    return Object.freeze({
      settings: this.#settingsStatus,
      servers: Object.freeze(
        [...this.#entries.values()].map((entry) =>
          Object.freeze({
            name: entry.settings.name,
            transport: entry.settings.transport,
            state: entry.session.reportedState
          })
        )
      )
    })
  }

  /**
   * Lists the tools of every connected server.
   *
   * @returns A frozen list in the settings group's order, each server's
   * tools in its own order.
   */
  public listToolDefinitions(): readonly McpToolDefinition[] {
    return Object.freeze(
      [...this.#entries.values()].flatMap((entry) =>
        entry.session.listToolDefinitions()
      )
    )
  }

  /**
   * Finds one MCP tool a request offers.
   *
   * @param toolName - Model-facing name of the tool, such as
   * `mcp__files__read`.
   * @returns `found` when the named server is connected and lists the tool;
   * `not-connected` when the server is applied but connecting or failed;
   * `unknown` otherwise. A found tool's calls run on the server's session as
   * it is when each call runs.
   */
  public findTurnTool(toolName: string): McpTurnToolLookup {
    const serverName = findMcpServerName(toolName)
    const entry =
      serverName === undefined ? undefined : this.#entries.get(serverName)
    if (entry === undefined) return UNKNOWN_TOOL
    const lookup = entry.session.findTool(toolName)
    if (lookup.status !== "found") return lookup
    const { definition } = lookup
    return Object.freeze({
      status: "found",
      tool: Object.freeze({
        definition,
        callTool: (
          callArguments: McpToolCallArguments,
          abortSignal: AbortSignal
        ) => this.#callTool(definition, callArguments, abortSignal)
      })
    })
  }

  /**
   * Stops every session and forgets every server.
   *
   * @returns A promise that settles once every settings read, opening, and
   * close the registry started has ended; every later call does the same.
   */
  public async close(): Promise<void> {
    this.#isClosed = true
    for (const entry of this.#entries.values()) void entry.session.stop()
    this.#entries = new Map()
    await this.#settingsReads
    await this.#settleTasks()
  }

  /**
   * Waits until no background task is left.
   *
   * @returns A promise that settles once the tracked tasks, and every task
   * they start while it waits, have settled.
   * @remarks A settling task can start another, such as an opening that
   * finishes after {@link close} and closes its connection, so the wait
   * repeats until the set stays empty.
   */
  async #settleTasks(): Promise<void> {
    if (this.#tasks.size === 0) return
    await Promise.allSettled(this.#tasks)
    await this.#settleTasks()
  }

  /**
   * Reads the settings group and applies what it holds.
   *
   * @returns A promise that settles once the read was applied.
   * @throws Only when closing the settings file fails.
   */
  async #readAndApply(): Promise<void> {
    if (this.#isClosed) return
    const read = await this.#dependencies.readSettings()
    if (this.#isClosed) return
    switch (read.status) {
      case "read":
        this.#settingsStatus = "applied"
        this.#applyServers(read.settings.servers)
        return
      case "invalid":
        this.#settingsStatus = "invalid"
        this.#dependencies.reportEvent({
          kind: "settings-invalid",
          problems: read.problems
        })
        return
      case "unreadable":
        this.#settingsStatus = "unreadable"
        this.#dependencies.reportEvent({ kind: "settings-unreadable" })
        return
    }
  }

  /**
   * Applies the servers of a settings group that passed its rules.
   *
   * @param servers - Validated servers in the group's order, each name once.
   */
  #applyServers(servers: readonly McpServerSettings[]): void {
    const previousEntries = this.#entries
    const appliedNames = new Set(servers.map((settings) => settings.name))
    for (const [serverName, entry] of previousEntries)
      if (!appliedNames.has(serverName)) void entry.session.stop()
    this.#entries = new Map()
    for (const settings of servers) {
      const entry = previousEntries.get(settings.name)
      if (entry !== undefined && isDeepStrictEqual(entry.settings, settings)) {
        this.#entries.set(settings.name, entry)
        continue
      }
      this.#startSession(settings, entry?.session.stop())
    }
  }

  /**
   * Starts a session that opens one server, and records it as the server's.
   *
   * @param settings - Validated settings of the server.
   * @param previousRelease - Release of the session it replaces, which the
   * opening waits for; undefined when it replaces none.
   */
  #startSession(
    settings: McpServerSettings,
    previousRelease: Promise<void> | undefined
  ): void {
    const session = new McpServerSession(settings, {
      openServer: this.#dependencies.openServer,
      workingDirectory: this.#dependencies.workingDirectory,
      reportEvent: this.#dependencies.reportEvent,
      trackTask: (task) => this.#trackTask(task)
    })
    this.#entries.set(settings.name, Object.freeze({ settings, session }))
    this.#trackTask(session.open(previousRelease))
  }

  /**
   * Keeps one background task until it settles, so {@link close} can wait
   * for it.
   *
   * @param task - Task that never rejects.
   */
  #trackTask(task: Promise<void>): void {
    this.#tasks.add(task)
    void task.finally(() => this.#tasks.delete(task))
  }

  /**
   * Runs one call of an MCP tool on its server's session as it is now.
   *
   * @param definition - The tool, as it was offered.
   * @param callArguments - Arguments whose shape the backend checked.
   * @param abortSignal - Stops the call.
   * @returns The server's result, or why the call failed, such as the
   * server not being applied any more.
   * @throws Only once the signal aborted.
   */
  #callTool(
    definition: McpToolDefinition,
    callArguments: McpToolCallArguments,
    abortSignal: AbortSignal
  ): Promise<McpToolCallOutcome> {
    const entry = this.#entries.get(definition.server)
    return entry === undefined
      ? Promise.resolve(buildServerNotConnectedOutcome(definition))
      : entry.session.callTool(definition, callArguments, abortSignal)
  }
}

/**
 * Finds the server a model-facing MCP tool name belongs to.
 *
 * @param toolName - Model-facing tool name.
 * @returns The text between `mcp__` and the next `__`, or undefined when the
 * name has no such part. Server names hold no `_`, so the split is exact.
 */
function findMcpServerName(toolName: string): string | undefined {
  if (!toolName.startsWith(MCP_TOOL_NAME_PREFIX)) return undefined
  const rest = toolName.slice(MCP_TOOL_NAME_PREFIX.length)
  const separator = rest.indexOf("__")
  return separator > 0 ? rest.slice(0, separator) : undefined
}
