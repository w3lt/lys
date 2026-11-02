import type { McpServerList, McpServerState } from "@lys/protocol"
import {
  MCP_TOOL_NAME_PREFIX,
  type BuiltInMcpServerName,
  type McpServerSettings,
  type McpServerTransport,
  type McpSettings,
  type McpToolDefinition
} from "@lys/share"
import { isDeepStrictEqual } from "node:util"
import type { McpSettingsRead } from "../../infrastructure/settings/mcpSettingsFile"
import type { McpToolCallArguments } from "./mcpServerConnection"
import type { McpServerEvent } from "./mcpServerEvent"
import McpServerSession, {
  buildCallNotSentEvent,
  buildServerNotConnectedOutcome,
  type McpServerSessionDependencies
} from "./mcpServerSession"
import type { McpToolCallOutcome } from "./mcpToolResult"

/** Why a built-in server that is switched on cannot start. */
export type BuiltInMcpServerProblem = Extract<
  McpServerEvent,
  { kind: "built-in-unusable" }
>["reason"]

/** What reading what a built-in server needs found. */
export type BuiltInMcpServerRead =
  | Readonly<{
      /** The server can start. */
      status: "read"
      /** Validated settings it starts with, named as the server is. */
      settings: McpServerSettings
    }>
  | Readonly<{
      /** No account is saved for the server. */
      status: "account-missing"
    }>
  | Readonly<{
      /** The saved account or its password fails its rules or could not be read. */
      status: "account-invalid"
    }>

/**
 * One server Lys ships, which the person switches on in the `mcp` settings
 * group rather than adds.
 */
export type BuiltInMcpServer = Readonly<{
  /** Name it is listed under; an added server of the same name takes its place. */
  name: BuiltInMcpServerName
  /** How the backend talks to it, reported while it is off or cannot start. */
  transport: McpServerTransport
  /**
   * Reads what the server needs, such as a saved account, and builds the
   * settings it starts with; called each time the settings are applied
   * with the server switched on and its name free.
   */
  readServer: () => Promise<BuiltInMcpServerRead>
}>

/**
 * What the registry borrows for its lifetime: the settings reader, the
 * servers Lys ships, and the opener, working folder, process group holder,
 * and reporter every server's session borrows.
 */
export type McpServerRegistryDependencies = Readonly<{
  /** Reads the `mcp` group from the settings file again. */
  readSettings: () => Promise<McpSettingsRead>
  /** Servers Lys ships, in the order they are listed, each name once. */
  builtInServers: readonly BuiltInMcpServer[]
}> &
  Omit<McpServerSessionDependencies, "addTask">

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
  sendToolCall: (
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
      /** The tool's server is applied but not connected now, or switched off. */
      status: "not-connected"
    }>
  | Readonly<{
      /** No applied server, or no connected server's tool, has the name. */
      status: "unknown"
    }>

/**
 * Outcome of asking one server to connect again: `reconnecting` once a new
 * session was started, `not-found` when no applied server has the name,
 * `off` when the server is switched off or, for a built-in server, cannot
 * start.
 */
export type McpServerReconnection = "reconnecting" | "not-found" | "off"

/** What one applied server does now. */
type ServerRun =
  | Readonly<{
      /** A session opens the server or holds its connection or failure. */
      status: "running"
      /** Validated settings the session opens. */
      settings: McpServerSettings
      /** The session. */
      session: McpServerSession
    }>
  | Readonly<{
      /** The person switched the server off; nothing runs. */
      status: "off"
    }>
  | Readonly<{
      /** The built-in server is switched on but cannot start. */
      status: "unusable"
      /** Why. */
      reason: BuiltInMcpServerProblem
    }>

/** One applied server. */
type ServerEntry = Readonly<{
  /** Name it is listed under. */
  name: string
  /** How the backend talks to it. */
  transport: McpServerTransport
  /** Whether Lys ships it. */
  isBuiltIn: boolean
  /** What it does now. */
  run: ServerRun
}>

/** What one server of a settings group just read is to do. */
type PlannedRun =
  | Readonly<{
      /** Open it in a session. */
      status: "start"
      /** Validated settings to open it with. */
      settings: McpServerSettings
    }>
  | Readonly<{
      /** Keep it off. */
      status: "off"
    }>
  | Readonly<{
      /** Report that the built-in server cannot start. */
      status: "unusable"
      /** Why. */
      reason: BuiltInMcpServerProblem
    }>

/** One server of a settings group just read, and what it is to do. */
type ServerPlan = Readonly<{
  /** Name it is listed under. */
  name: string
  /** How the backend talks to it. */
  transport: McpServerTransport
  /** Whether Lys ships it. */
  isBuiltIn: boolean
  /** What it is to do. */
  run: PlannedRun
}>

/** A settings group just read, as the registry is to apply it. */
type SettingsPlan = Readonly<{
  /** Each server in the order it is listed, each name once. */
  servers: readonly ServerPlan[]
  /** Names of the built-in servers an added server took. */
  takenBuiltInNames: ReadonlySet<string>
}>

/** Why a session was stopped as settings were applied. */
type StopReason = Extract<McpServerEvent, { kind: "server-stopped" }>["reason"]

/** Outcome of the last read of the settings group. */
type SettingsStatus = McpServerList["settings"]

/** Lookup of a name no applied server has. */
const UNKNOWN_TOOL: McpTurnToolLookup = Object.freeze({ status: "unknown" })

/** Lookup of a tool whose server is switched off or cannot start. */
const NOT_CONNECTED_TOOL: McpTurnToolLookup = Object.freeze({
  status: "not-connected"
})

/** Run of a server that is switched off. */
const OFF_RUN: ServerRun = Object.freeze({ status: "off" })

/** Plan of a server that is to stay off. */
const OFF_PLAN: PlannedRun = Object.freeze({ status: "off" })

/** State the list reports for a server that is switched off. */
const OFF_STATE: McpServerState = Object.freeze({ status: "off" })

/**
 * Owns the MCP servers the settings file names and the servers Lys ships,
 * one session each while it is switched on, for the backend's lifetime.
 *
 * @remarks {@link updateServers} reads the `mcp` group and applies it: a
 * new or changed server that is switched on gets a new session, an
 * unchanged one keeps its session, with its connection or failure, and a
 * removed or switched-off one's session is stopped. A built-in server comes
 * first in the list; while it is switched on, each apply reads what it
 * needs, such as a saved account, and starts it in a session, or lists it
 * as failed when it cannot start; an added server of its name takes its
 * place. Opening runs in the background; the list reports each server as
 * connecting until its opening ends. Nothing reconnects by itself:
 * {@link openServerAgain} or a changed setting starts a new session. Every new
 * session opens only once every session the registry stopped before it
 * released its server, whatever name either has, so the process group a
 * command server's command started, the server a launcher like `npx` runs
 * included, has ended before the next one starts, after a rename or a
 * removal and re-adding too. Settings that fail their rules or cannot be
 * read keep the servers applied before.
 * Resource ownership: owns every session it started until it stops it; a
 * stopped session closes its connection, now or when its opening ends.
 * Concurrency model: single-threaded with background tasks; settings reads
 * run one after another in call order, each applied synchronously once
 * read, and every state change happens synchronously, so a lookup always
 * sees one consistent state. {@link close} is idempotent and waits for every
 * opening and close it started.
 */
export default class McpServerRegistry {
  /**
   * Borrowed settings reader, built-in servers, opener, working folder,
   * process group holder, and reporter.
   */
  readonly #dependencies: McpServerRegistryDependencies
  /** Applied servers in list order: the built-in ones, then the group's. */
  #entries: Map<string, ServerEntry>
  /** Names of the built-in servers an added server took at the last apply. */
  #takenBuiltInNames: ReadonlySet<string>
  /** Outcome of the last read of the settings group. */
  #settingsStatus: SettingsStatus
  /** Settles once every settings read asked for so far was applied. */
  #settingsReads: Promise<unknown>
  /** Openings and closes still running. */
  readonly #tasks: Set<Promise<void>>
  /**
   * Releases of the stopped sessions that have not released their servers
   * yet; a new session opens once all of them settled.
   */
  readonly #releases: Set<Promise<void>>
  /** Whether {@link close} was called. */
  #isClosed: boolean

  /**
   * Creates a registry with no server.
   *
   * @param dependencies - Settings reader, built-in servers, opener,
   * working folder, process group holder, and reporter, borrowed for the
   * registry's lifetime.
   * @remarks Reads, starts, and contacts nothing.
   */
  public constructor(dependencies: McpServerRegistryDependencies) {
    this.#dependencies = dependencies
    this.#entries = new Map()
    this.#takenBuiltInNames = new Set()
    this.#settingsStatus = "applied"
    this.#settingsReads = Promise.resolve()
    this.#tasks = new Set()
    this.#releases = new Set()
    this.#isClosed = false
  }

  /**
   * Reads the `mcp` settings group again, and what each built-in server
   * it switches on needs, and applies them.
   *
   * @returns A promise that settles once the group was read and applied;
   * the servers it opens are still connecting then.
   * @throws Only when closing the settings file fails.
   * @remarks Reads run one after another in call order. After
   * {@link close}, it reads nothing.
   */
  public updateServers(): Promise<void> {
    const applying = this.#settingsReads.then(() => this.#readAndApply())
    this.#settingsReads = Promise.allSettled([applying])
    return applying
  }

  /**
   * Stops one applied server's session and opens the server again in a new
   * one.
   *
   * @param serverName - Name of the server, compared exactly.
   * @returns `reconnecting` once the new session was started; `not-found`
   * when no applied server has the name, which is always the case after
   * {@link close}; `off` when the server is switched off or cannot start,
   * so there is no session to open again.
   * @remarks The new session opens once the old one, and every other session
   * stopped before, released its server.
   */
  public openServerAgain(serverName: string): McpServerReconnection {
    const entry = this.#entries.get(serverName)
    if (entry === undefined) return "not-found"
    if (entry.run.status !== "running") return "off"
    const { settings } = entry.run
    this.#stopSession(entry.run.session)
    this.#entries.set(
      serverName,
      Object.freeze({
        ...entry,
        run: Object.freeze({
          status: "running",
          settings,
          session: this.#startSession(settings)
        })
      })
    )
    return "reconnecting"
  }

  /**
   * Lists the applied servers and their states.
   *
   * @returns A frozen list, the built-in servers first in their fixed
   * order, then the added servers in the settings group's order, with the
   * outcome of the last settings read; it carries no setting.
   */
  public listServers(): McpServerList {
    return Object.freeze({
      settings: this.#settingsStatus,
      servers: Object.freeze(
        [...this.#entries.values()].map((entry) =>
          Object.freeze({
            name: entry.name,
            transport: entry.transport,
            isBuiltIn: entry.isBuiltIn,
            state: buildReportedState(entry.run)
          })
        )
      )
    })
  }

  /**
   * Lists the tools of every connected server.
   *
   * @returns A frozen list in list order, each server's tools in its own
   * order; a server that is switched off offers none.
   */
  public listToolDefinitions(): readonly McpToolDefinition[] {
    return Object.freeze(
      [...this.#entries.values()].flatMap((entry) =>
        entry.run.status === "running"
          ? entry.run.session.listToolDefinitions()
          : []
      )
    )
  }

  /**
   * Finds one MCP tool a request offers.
   *
   * @param toolName - Model-facing name of the tool, such as
   * `mcp__files__read`.
   * @returns `found` when the named server is connected and lists the tool;
   * `not-connected` when the server is applied but connecting, failed,
   * switched off, or unable to start; `unknown` otherwise. A found tool's
   * calls run on the server's session as it is when each call runs.
   */
  public findTurnTool(toolName: string): McpTurnToolLookup {
    const serverName = findMcpServerName(toolName)
    const entry =
      serverName === undefined ? undefined : this.#entries.get(serverName)
    if (entry === undefined) return UNKNOWN_TOOL
    if (entry.run.status !== "running") return NOT_CONNECTED_TOOL
    const lookup = entry.run.session.findTool(toolName)
    if (lookup.status !== "found") return lookup
    const { definition } = lookup
    return Object.freeze({
      status: "found",
      tool: Object.freeze({
        definition,
        sendToolCall: (
          callArguments: McpToolCallArguments,
          abortSignal: AbortSignal
        ) => this.#sendToolCall(definition, callArguments, abortSignal)
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
    for (const entry of this.#entries.values())
      if (entry.run.status === "running") void entry.run.session.stop()
    this.#entries = new Map()
    await this.#settingsReads
    await this.#waitForNoTaskLeft()
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
  async #waitForNoTaskLeft(): Promise<void> {
    if (this.#tasks.size === 0) return
    await Promise.allSettled(this.#tasks)
    await this.#waitForNoTaskLeft()
  }

  /**
   * Reads the settings group, and what each built-in server it switches on
   * needs, and applies what they hold.
   *
   * @returns A promise that settles once the read was applied.
   * @throws Only when closing the settings file fails.
   */
  async #readAndApply(): Promise<void> {
    if (this.#isClosed) return
    const read = await this.#dependencies.readSettings()
    if (this.#isClosed) return
    switch (read.status) {
      case "read": {
        const plan = await this.#createSettingsPlan(read.settings)
        if (this.#isClosed) return
        this.#settingsStatus = "applied"
        this.#updateEntries(plan)
        return
      }
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
   * Creates the plan of a settings group that passed its rules: what each
   * server is to do, reading what each built-in server it switches on needs.
   *
   * @param settings - The group.
   * @returns The built-in servers whose names are free, in their fixed
   * order, then the group's servers in its order, and the names of the
   * built-in servers an added server took.
   * @throws The first failure, in the built-in servers' order, of a read
   * of what one needs; every read has ended by then.
   */
  async #createSettingsPlan(settings: McpSettings): Promise<SettingsPlan> {
    const addedNames = new Set(settings.servers.map((server) => server.name))
    const { builtInServers } = this.#dependencies
    const builtInPlans = await createBuiltInServerPlans(
      builtInServers.filter((builtIn) => !addedNames.has(builtIn.name)),
      settings
    )
    const takenBuiltInNames = new Set(
      builtInServers
        .map((builtIn) => builtIn.name)
        .filter((name) => addedNames.has(name))
    )
    const addedPlans = settings.servers.map((server) =>
      buildAddedServerPlan(server)
    )
    return Object.freeze({
      servers: Object.freeze([...builtInPlans, ...addedPlans]),
      takenBuiltInNames
    })
  }

  /**
   * Updates the applied servers to a plan: keeps each running server whose
   * settings did not change, stops the others, and starts, switches off, or
   * reports each planned server.
   *
   * @param plan - What each server is to do.
   * @remarks Stops every session it does not keep before it starts any, so
   * each new session waits for all of them, such as when two servers swap
   * their settings. Reports each stopped session with why, each built-in
   * server that newly cannot start, and each built-in name newly taken.
   */
  #updateEntries(plan: SettingsPlan): void {
    const previousEntries = this.#entries
    const keptEntries = new Map<string, ServerEntry>()
    for (const server of plan.servers) {
      const entry = findUnchangedEntry(previousEntries, server)
      if (entry !== undefined) keptEntries.set(server.name, entry)
    }
    const plannedByName = new Map(
      plan.servers.map((server) => [server.name, server])
    )
    for (const [serverName, entry] of previousEntries) {
      if (entry.run.status !== "running" || keptEntries.has(serverName))
        continue
      this.#stopSession(entry.run.session)
      this.#dependencies.reportEvent({
        kind: "server-stopped",
        serverName,
        reason: findStopReason(entry, plannedByName.get(serverName))
      })
    }
    this.#entries = new Map()
    for (const server of plan.servers)
      this.#entries.set(
        server.name,
        keptEntries.get(server.name) ??
          this.#startServer(server, previousEntries.get(server.name))
      )
    this.#updateTakenBuiltInNames(plan.takenBuiltInNames)
  }

  /**
   * Starts, switches off, or reports one planned server.
   *
   * @param server - The plan.
   * @param previousEntry - The server's entry before the apply, if any.
   * @returns The server's new entry.
   * @remarks A built-in server that cannot start is reported once per
   * reason: not again while a later apply finds the same reason.
   */
  #startServer(
    server: ServerPlan,
    previousEntry: ServerEntry | undefined
  ): ServerEntry {
    const { name, transport, isBuiltIn } = server
    switch (server.run.status) {
      case "start": {
        const { settings } = server.run
        return Object.freeze({
          name,
          transport,
          isBuiltIn,
          run: Object.freeze({
            status: "running",
            settings,
            session: this.#startSession(settings)
          })
        })
      }
      case "off":
        return Object.freeze({ name, transport, isBuiltIn, run: OFF_RUN })
      case "unusable": {
        const { reason } = server.run
        if (
          previousEntry?.run.status !== "unusable" ||
          previousEntry.run.reason !== reason
        )
          this.#dependencies.reportEvent({
            kind: "built-in-unusable",
            serverName: name,
            reason
          })
        return Object.freeze({
          name,
          transport,
          isBuiltIn,
          run: Object.freeze({ status: "unusable", reason })
        })
      }
    }
  }

  /**
   * Updates the names of the built-in servers an added server took,
   * reporting each name newly taken; the next apply compares with them.
   *
   * @param takenNames - Names of the built-in servers an added server took.
   */
  #updateTakenBuiltInNames(takenNames: ReadonlySet<string>): void {
    for (const serverName of takenNames)
      if (!this.#takenBuiltInNames.has(serverName))
        this.#dependencies.reportEvent({
          kind: "built-in-name-taken",
          serverName
        })
    this.#takenBuiltInNames = takenNames
  }

  /**
   * Stops one session the registry no longer keeps, and keeps its release
   * until it settles, so later sessions open only after it.
   *
   * @param session - Session to stop.
   */
  #stopSession(session: McpServerSession): void {
    const release = session.stop()
    this.#releases.add(release)
    void release.finally(() => this.#releases.delete(release))
  }

  /**
   * Starts a session that opens one server.
   *
   * @param settings - Validated settings of the server.
   * @returns The session, which the caller records as the server's.
   * @remarks The opening waits until every session stopped so far released
   * its server; it starts at once when none is releasing.
   */
  #startSession(settings: McpServerSettings): McpServerSession {
    const session = new McpServerSession(settings, {
      openServer: this.#dependencies.openServer,
      workingDirectory: this.#dependencies.workingDirectory,
      processGroups: this.#dependencies.processGroups,
      reportEvent: this.#dependencies.reportEvent,
      addTask: (task) => this.#addTask(task)
    })
    const previousRelease =
      this.#releases.size === 0
        ? undefined
        : Promise.all(this.#releases).then(() => undefined)
    this.#addTask(session.open(previousRelease))
    return session
  }

  /**
   * Adds one background task to the tracked tasks until it settles, so
   * {@link close} can wait for it.
   *
   * @param task - Task that never rejects.
   */
  #addTask(task: Promise<void>): void {
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
   * server not being applied or switched on any more, which is reported as
   * a call that was not sent.
   * @throws Only once the signal aborted.
   */
  #sendToolCall(
    definition: McpToolDefinition,
    callArguments: McpToolCallArguments,
    abortSignal: AbortSignal
  ): Promise<McpToolCallOutcome> {
    const entry = this.#entries.get(definition.server)
    if (entry?.run.status === "running")
      return entry.run.session.sendToolCall(
        definition,
        callArguments,
        abortSignal
      )
    this.#dependencies.reportEvent(
      buildCallNotSentEvent(definition, "server-not-connected")
    )
    return Promise.resolve(buildServerNotConnectedOutcome(definition))
  }
}

/**
 * Creates the plan of each built-in server whose name is free.
 *
 * @param builtIns - The servers, in their fixed order.
 * @param settings - The settings group that switches each one on or off.
 * @returns Each server's plan, in the order given.
 * @throws The first failure, in the order given, of a read of what a
 * switched-on server needs.
 * @remarks Reads what the switched-on servers need at the same time, and
 * settles only once every read has ended, so no read outlives the apply
 * that started it.
 */
async function createBuiltInServerPlans(
  builtIns: readonly BuiltInMcpServer[],
  settings: McpSettings
): Promise<readonly ServerPlan[]> {
  const outcomes = await Promise.allSettled(
    builtIns.map((builtIn) =>
      settings.builtIn[builtIn.name].enabled
        ? createBuiltInServerPlan(builtIn)
        : buildOffBuiltInServerPlan(builtIn)
    )
  )
  const plans: ServerPlan[] = []
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") throw outcome.reason
    plans.push(outcome.value)
  }
  return plans
}

/**
 * Creates the plan of one built-in server the settings group switches on,
 * reading what it needs.
 *
 * @param server - The built-in server.
 * @returns A start with the settings its read built, or why it cannot
 * start.
 * @throws The read's failure.
 */
async function createBuiltInServerPlan(
  server: BuiltInMcpServer
): Promise<ServerPlan> {
  const read = await server.readServer()
  return Object.freeze({
    name: server.name,
    transport: server.transport,
    isBuiltIn: true,
    run:
      read.status === "read"
        ? Object.freeze({ status: "start", settings: read.settings })
        : Object.freeze({ status: "unusable", reason: read.status })
  })
}

/**
 * Builds the plan of one built-in server the settings group switches off.
 *
 * @param server - The built-in server.
 * @returns Off.
 */
function buildOffBuiltInServerPlan(server: BuiltInMcpServer): ServerPlan {
  return Object.freeze({
    name: server.name,
    transport: server.transport,
    isBuiltIn: true,
    run: OFF_PLAN
  })
}

/**
 * Builds the plan of one added server.
 *
 * @param settings - Its validated settings.
 * @returns A start with its settings while it is switched on, else off.
 */
function buildAddedServerPlan(settings: McpServerSettings): ServerPlan {
  return Object.freeze({
    name: settings.name,
    transport: settings.transport,
    isBuiltIn: false,
    run: settings.enabled
      ? Object.freeze({ status: "start", settings })
      : OFF_PLAN
  })
}

/**
 * Finds the running entry a planned server keeps.
 *
 * @param entries - Applied servers by name.
 * @param server - The server's plan from the group just read.
 * @returns The entry of the same name and origin whose session opens equal
 * settings, or undefined when the server is new, changed, switched off, or
 * unable to start.
 */
function findUnchangedEntry(
  entries: ReadonlyMap<string, ServerEntry>,
  server: ServerPlan
): ServerEntry | undefined {
  const entry = entries.get(server.name)
  return entry?.isBuiltIn === server.isBuiltIn &&
    hasEqualSettings(entry.run, server.run)
    ? entry
    : undefined
}

/**
 * Answers whether a server's running session opens the settings its plan
 * starts it with.
 *
 * @param run - What the server does now.
 * @param plannedRun - What its plan from the group just read is to do.
 * @returns True when both are a session and a start with deeply equal
 * settings; false when either is off or unable to start.
 */
function hasEqualSettings(run: ServerRun, plannedRun: PlannedRun): boolean {
  return (
    run.status === "running" &&
    plannedRun.status === "start" &&
    isDeepStrictEqual(run.settings, plannedRun.settings)
  )
}

/**
 * Finds why a running server's session is stopped by an apply.
 *
 * @param entry - The running server.
 * @param server - Its plan from the group just read, if the group names
 * it.
 * @returns `removed` when the group no longer names it, or an added server
 * took the built-in server's name; `switched-off` when the group switches
 * it off; `changed` otherwise.
 */
function findStopReason(
  entry: ServerEntry,
  server: ServerPlan | undefined
): StopReason {
  if (server?.isBuiltIn !== entry.isBuiltIn) return "removed"
  return server.run.status === "off" ? "switched-off" : "changed"
}

/**
 * Builds the state the server list reports for what a server does now.
 *
 * @param run - What it does now.
 * @returns Its session's reported state, `off`, or `failed` with why the
 * built-in server cannot start.
 */
function buildReportedState(run: ServerRun): McpServerState {
  switch (run.status) {
    case "running":
      return run.session.reportedState
    case "off":
      return OFF_STATE
    case "unusable":
      return Object.freeze({ status: "failed", reason: run.reason })
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
