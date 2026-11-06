import {
  MAXIMUM_MCP_SERVER_TOOL_COUNT,
  type McpServerFailure,
  type McpServerList,
  type McpServerState,
  type SkippedMcpTool
} from "@lys/protocol"
import {
  mcpSettingsSchema,
  type BuiltInMcpSettings,
  type McpEnvironmentVariable,
  type McpServerSettings
} from "@lys/share"
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  describe,
  expect,
  it,
  onTestFinished,
  vi,
  type MockInstance
} from "vitest"
import type { McpSettingsRead } from "../../../../src/infrastructure/settings/mcpSettingsFile"
import type McpServerConnection from "../../../../src/modules/mcp/mcpServerConnection"
import type { McpServerConnectionContext } from "../../../../src/modules/mcp/mcpServerConnection"
import {
  openMcpServer,
  type McpServerOpening
} from "../../../../src/modules/mcp/mcpServerOpening"
import type { McpServerEvent } from "../../../../src/modules/mcp/mcpServerEvent"
import McpServerRegistry, {
  type BuiltInMcpServer,
  type BuiltInMcpServerRead,
  type McpServerRegistryDependencies,
  type TurnMcpTool
} from "../../../../src/modules/mcp/mcpServerRegistry"
import {
  answerAsMcpServer,
  answerToolCallsWith,
  answerWithStatus,
  buildFakeLauncherServerSettings,
  buildFakeStdioServerSettings,
  buildHttpServerSettings,
  ECHO_TOOL,
  findClosedMcpUrl,
  startFakeMcpHttpServer,
  type McpHttpRoute
} from "../../support/mcpTestServers"
import { waitForMicrotasks } from "../../support/microtasks"
import { createSettlementReader } from "../../support/settlement"
import { createOwnedMcpServerProcessGroups } from "../../support/mcpServerProcessGroups"

/** Longest one test opening may take; far above a local fake server's start. */
const OPENING_TIMEOUT_MILLISECONDS = 10_000

/** Bound of every wait for the servers to reach a state. */
const STATE_WAIT = Object.freeze({ timeout: 10_000, interval: 10 })

/**
 * Longest a test waits for a server whose old process group ends only at
 * `SIGKILL`, six seconds after its stop started, to connect again.
 */
const LAUNCHER_STATE_WAIT = Object.freeze({ timeout: 20_000, interval: 10 })

/** Longest one case may run; a case starts several server processes. */
const CASE_TIMEOUT_MILLISECONDS = 30_000

/** Folder the registry starts stdio servers in; not the test's own folder. */
const WORKING_DIRECTORY = realpathSync(tmpdir())

/** Signal of calls the case never cancels. */
const NEVER_ABORTED = new AbortController().signal

/** Opening of an attempt that was cancelled before it started anything. */
const CANCELLED_OPENING: McpServerOpening = Object.freeze({
  status: "cancelled"
})

/**
 * Builds a tool the fake servers list with an empty object input schema.
 *
 * @param name - The server's name for the tool.
 * @returns The tool as a server lists it.
 */
function buildTool(name: string): Readonly<{
  name: string
  inputSchema: Readonly<{ type: "object" }>
}> {
  return Object.freeze({ name, inputSchema: Object.freeze({ type: "object" }) })
}

/** Tool whose call makes the fake stdio server exit. */
const EXIT_TOOL = buildTool("exit")

/** Tool whose call the fake stdio server never answers. */
const SLOW_TOOL = buildTool("slow")

/** Tool whose call the fake stdio server answers with a JSON-RPC error. */
const REFUSE_TOOL = buildTool("refuse")

/** Tool whose call the fake stdio server answers with `isError`. */
const FAIL_TOOL = buildTool("fail")

/** Tool the model calls `look_up` once its `.` is replaced. */
const LOOK_DOT_UP_TOOL = buildTool("look.up")

/** Tool the model calls `look_up` too. */
const LOOK_UNDERSCORE_UP_TOOL = buildTool("look_up")

/** State of a server being opened. */
const CONNECTING: McpServerState = Object.freeze({ status: "connecting" })

/** How long a one-copy fake server takes to exit once its input closes. */
const ONE_COPY_SHUTDOWN_MILLISECONDS = 1000

/**
 * Creates an empty folder for the stdio servers of one case, removed after
 * the case.
 *
 * @returns Absolute path of the folder.
 */
function createServerFolder(): string {
  const folder = mkdtempSync(join(WORKING_DIRECTORY, "lys-mcp-servers-"))
  onTestFinished(() => rmSync(folder, { recursive: true, force: true }))
  return folder
}

/**
 * Builds a command server that runs one copy at a time, like a server that
 * holds a lock or a port: it holds a lock file in the folder it runs in, and
 * exits only {@link ONE_COPY_SHUTDOWN_MILLISECONDS} after its input closes.
 *
 * @param name - Server name.
 * @param environment - Its variables.
 * @returns Validated settings of the server.
 */
function buildOneCopyServerSettings(
  name: string,
  environment: readonly McpEnvironmentVariable[]
): McpServerSettings {
  return buildFakeStdioServerSettings(
    name,
    {
      holdLock: true,
      shutdownDelayMilliseconds: ONE_COPY_SHUTDOWN_MILLISECONDS
    },
    environment
  )
}

/**
 * Opens one server as production does, with the test time limit.
 *
 * @param settings - Validated settings of the server.
 * @param context - Context the registry gave the opening.
 * @returns How the opening ended.
 */
function openFakeServer(
  settings: McpServerSettings,
  context: McpServerConnectionContext
): Promise<McpServerOpening> {
  return openMcpServer(settings, context, OPENING_TIMEOUT_MILLISECONDS)
}

/**
 * Opens one server for the registry under test.
 *
 * @param settings - Validated settings of the server.
 * @param context - Context the registry gave the opening.
 * @param testEnded - Settles once the case ended, so an opening that waits
 * on the case never strands its teardown.
 * @returns How the opening ended.
 */
type TestOpener = (
  settings: McpServerSettings,
  context: McpServerConnectionContext,
  testEnded: Promise<void>
) => Promise<McpServerOpening>

/** One connection an opening ended with, as the case observes it. */
type OpenedConnection = Readonly<{
  /** Name of its server. */
  serverName: string
  /** The connection, which the registry owns. */
  connection: McpServerConnection
  /** Records each time the connection is asked to close. */
  close: MockInstance<McpServerConnection["close"]>
}>

/** What a case may replace in the registry's dependencies. */
type RegistryHarnessOptions = Readonly<{
  /** Opens each server; {@link openFakeServer} when omitted. */
  open?: TestOpener
  /**
   * Reads the settings; the harness's servers when omitted.
   *
   * @param testEnded - Settles once the case ended.
   */
  readSettings?: (testEnded: Promise<void>) => Promise<McpSettingsRead>
  /** Folder the stdio servers start in; {@link WORKING_DIRECTORY} when omitted. */
  workingDirectory?: string
  /** Servers Lys ships; none when omitted. */
  builtInServers?: readonly BuiltInMcpServer[]
}>

/** A registry under test, what it was given, and what it reported. */
type RegistryHarness = Readonly<{
  /** The registry, closed when the case finishes. */
  registry: McpServerRegistry
  /** Every event the registry reported, in order. */
  events: readonly McpServerEvent[]
  /** Records every settings read. */
  readSettings: MockInstance<() => Promise<McpSettingsRead>>
  /** Records every opening the registry started, with its context. */
  openServer: MockInstance<
    (
      settings: McpServerSettings,
      context: McpServerConnectionContext
    ) => Promise<McpServerOpening>
  >
  /** Every connection an opening ended with, in the order the openings ended. */
  openedConnections: readonly OpenedConnection[]
  /**
   * Makes every later read return these servers, parsed anew on each read.
   *
   * @param servers - Servers in settings order.
   * @param builtIn - Switches of the built-in servers; every one off when
   * omitted.
   */
  setServers: (
    servers: readonly McpServerSettings[],
    builtIn?: BuiltInMcpSettings
  ) => void
  /**
   * Makes every later read return this outcome.
   *
   * @param read - Outcome of each read.
   */
  setSettingsRead: (read: McpSettingsRead) => void
  /**
   * Holds every opening started from now on before it starts anything,
   * until released, until its signal aborts, or until the case ends.
   *
   * @returns Releases the held openings and stops holding new ones.
   */
  holdOpenings: () => () => void
}>

/**
 * Builds a settings read of these servers, parsed from JSON as the settings
 * file reader does, so equal settings are never the same objects.
 *
 * @param servers - Servers in settings order.
 * @param builtIn - Switches of the built-in servers; every one off when
 * omitted.
 * @returns A `read` outcome.
 */
function buildSettingsRead(
  servers: readonly McpServerSettings[],
  builtIn?: BuiltInMcpSettings
): McpSettingsRead {
  const settings = mcpSettingsSchema.parse(
    JSON.parse(JSON.stringify({ servers, builtIn }))
  )
  return Object.freeze({ status: "read", settings })
}

/** The switch of a built-in server that is on. */
const SWITCH_ON: BuiltInMcpSettings["email"] = Object.freeze({ enabled: true })

/** Switches that switch the built-in email server on. */
const EMAIL_ON: BuiltInMcpSettings = Object.freeze({ email: SWITCH_ON })

/** A recorded built-in email server, and what its reads return. */
type FakeBuiltInServer = Readonly<{
  /** The server, over stdio, named `email`. */
  server: BuiltInMcpServer
  /** Records every read. */
  readServer: MockInstance<() => Promise<BuiltInMcpServerRead>>
  /**
   * Makes every later read return this outcome.
   *
   * @param read - Outcome of each read.
   */
  setRead: (read: BuiltInMcpServerRead) => void
}>

/**
 * Creates a built-in email server whose reads return what the case sets.
 *
 * @param read - Outcome of each read until the case sets another; a start
 * with the fake stdio server named `email` when omitted.
 * @returns The server and its recorded reads.
 */
function createFakeBuiltInServer(
  read: BuiltInMcpServerRead = buildBuiltInRead(
    buildFakeStdioServerSettings("email")
  )
): FakeBuiltInServer {
  let nextRead = read
  const readServer = vi.fn(() => Promise.resolve(nextRead))
  const server: BuiltInMcpServer = Object.freeze({
    name: "email",
    transport: "stdio",
    readServer
  })
  return Object.freeze({
    server,
    readServer,
    setRead: (next) => {
      nextRead = next
    }
  })
}

/**
 * Builds the read of a built-in server that can start.
 *
 * @param settings - Settings it starts with.
 * @returns A `read` outcome.
 */
function buildBuiltInRead(settings: McpServerSettings): BuiltInMcpServerRead {
  return Object.freeze({ status: "read", settings })
}

/** State the list reports for a server that is switched off. */
const OFF: McpServerState = Object.freeze({ status: "off" })

/**
 * Builds a server's settings switched off.
 *
 * @param settings - Validated settings of the server.
 * @returns The same settings, switched off.
 */
function buildSwitchedOffSettings(
  settings: McpServerSettings
): McpServerSettings {
  return Object.freeze({ ...settings, enabled: false })
}

/**
 * Builds the status of the built-in email server.
 *
 * @param state - Its state.
 * @returns The status the list reports.
 */
function buildEmailStatus(
  state: McpServerState
): McpServerList["servers"][number] {
  return { name: "email", transport: "stdio", isBuiltIn: true, state }
}

/**
 * Waits until a signal aborts.
 *
 * @param signal - Signal to watch.
 * @returns A promise that settles once the signal aborted.
 */
function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener("abort", () => resolve(), { once: true })
  })
}

/**
 * Makes a connection's close wait for a promise before it closes.
 *
 * @param connection - Connection whose close is held.
 * @param release - Settles when the close may go on.
 */
function holdCloseUntil(
  connection: McpServerConnection,
  release: Promise<void>
): void {
  const close = connection.close.bind(connection)
  vi.spyOn(connection, "close").mockImplementation(async () => {
    await release
    await close()
  })
}

/**
 * Owns the hold on new openings, to open each server the registry under test
 * asks for with the case's opener once no hold stops it.
 *
 * @remarks Holds new openings from each {@link HoldableServerOpener.startHold}
 * until the next release of a hold. An opening started while held waits,
 * before it starts anything, until its hold is released, until its signal
 * aborts, or until the case ends; it then ends cancelled if its signal
 * aborted, and opens otherwise. An opening started while nothing is held
 * opens at once. The case's opener and the promise of the case's end are
 * borrowed from the harness. Concurrency model: single-owner, on the test's
 * event loop.
 */
class HoldableServerOpener {
  /** Opens each server once no hold stops it. */
  readonly #open: TestOpener
  /** Settles once the case ended, which ends every wait on a hold. */
  readonly #testEnded: Promise<void>
  /**
   * Settles once the hold on new openings is released; undefined while
   * nothing is held.
   */
  #heldUntil: Promise<void> | undefined = undefined

  /**
   * Creates the opener with nothing held.
   *
   * @param open - Opens each server: the case's opener, or the default one.
   * @param testEnded - Settles once the case ended; also lent to every
   * opening.
   */
  public constructor(open: TestOpener, testEnded: Promise<void>) {
    this.#open = open
    this.#testEnded = testEnded
  }

  /**
   * Opens one server once the hold that was on when the opening started no
   * longer stops it.
   *
   * @param settings - Validated settings of the server.
   * @param context - Context the registry gave the opening.
   * @returns How the opening ended: cancelled, without starting anything,
   * when it was held and its signal aborted before it went on; otherwise
   * what the case's opener returned.
   */
  public async openServer(
    settings: McpServerSettings,
    context: McpServerConnectionContext
  ): Promise<McpServerOpening> {
    const heldUntil = this.#heldUntil
    if (heldUntil !== undefined) {
      await Promise.race([
        heldUntil,
        waitForAbort(context.abortSignal),
        this.#testEnded
      ])
      if (context.abortSignal.aborted) return CANCELLED_OPENING
    }
    return this.#open(settings, context, this.#testEnded)
  }

  /**
   * Starts holding every opening started from now on.
   *
   * @returns Releases the openings this hold holds, and stops holding new
   * ones.
   */
  public startHold(): () => void {
    const release = Promise.withResolvers<void>()
    this.#heldUntil = release.promise
    return () => {
      this.#heldUntil = undefined
      release.resolve()
    }
  }
}

/**
 * Adds the connection an opening ended with to the case's observations, with
 * a spy on its close.
 *
 * @param openedConnections - The case's connections, in the order the
 * openings ended; it gains one when the opening connected.
 * @param serverName - Name of the opened server.
 * @param opening - How the opening ended; one that did not connect has no
 * connection to add.
 */
function addOpenedConnection(
  openedConnections: OpenedConnection[],
  serverName: string,
  opening: McpServerOpening
): void {
  if (opening.status === "connected")
    openedConnections.push(
      Object.freeze({
        serverName,
        connection: opening.connection,
        close: vi.spyOn(opening.connection, "close")
      })
    )
}

/**
 * Creates a registry whose settings reads return what the case sets and
 * whose openings start real fake servers, closed when the case finishes.
 *
 * @param options - Opener, settings reader, working folder, and built-in
 * servers replacing the defaults.
 * @returns The registry and what it was given and reported.
 * @remarks Teardown first ends every wait on the case, then closes the
 * registry, which waits for every opening and close it started.
 */
function createRegistryHarness(
  options: RegistryHarnessOptions = {}
): RegistryHarness {
  const testEnd = Promise.withResolvers<void>()
  const events: McpServerEvent[] = []
  const openedConnections: OpenedConnection[] = []
  const serverOpener = new HoldableServerOpener(
    options.open ?? openFakeServer,
    testEnd.promise
  )
  let nextRead: () => McpSettingsRead = () => buildSettingsRead([])
  const readSettings = vi.fn(() =>
    options.readSettings === undefined
      ? Promise.resolve(nextRead())
      : options.readSettings(testEnd.promise)
  )
  const openServer = vi.fn<McpServerRegistryDependencies["openServer"]>(
    async (settings, context) => {
      const opening = await serverOpener.openServer(settings, context)
      addOpenedConnection(openedConnections, settings.name, opening)
      return opening
    }
  )
  const { processGroups } = createOwnedMcpServerProcessGroups()
  const registry = new McpServerRegistry({
    readSettings,
    builtInServers: options.builtInServers ?? [],
    openServer,
    workingDirectory: options.workingDirectory ?? WORKING_DIRECTORY,
    processGroups,
    reportEvent: (event) => events.push(event)
  })
  onTestFinished(async () => {
    testEnd.resolve()
    await registry.close()
  })
  return Object.freeze({
    registry,
    events,
    readSettings,
    openServer,
    openedConnections,
    setServers: (servers, builtIn) => {
      nextRead = () => buildSettingsRead(servers, builtIn)
    },
    setSettingsRead: (read) => {
      nextRead = () => read
    },
    holdOpenings: () => serverOpener.startHold()
  })
}

/**
 * Builds the state of a connected server.
 *
 * @param toolCount - Tools listed for it.
 * @param skippedTools - Tools read but not listed.
 * @param isToolListCut - Whether it has more tools than the backend reads.
 * @returns The state.
 */
function buildConnectedState(
  toolCount: number,
  skippedTools: readonly SkippedMcpTool[] = [],
  isToolListCut = false
): McpServerState {
  return { status: "connected", toolCount, skippedTools, isToolListCut }
}

/**
 * Builds the state of a server that is not connected.
 *
 * @param reason - Why.
 * @returns The state.
 */
function buildFailedState(reason: McpServerFailure): McpServerState {
  return { status: "failed", reason }
}

/**
 * Builds the status of a stdio server.
 *
 * @param name - Server name.
 * @param state - Its state.
 * @returns The status the list reports.
 */
function buildStdioStatus(
  name: string,
  state: McpServerState
): McpServerList["servers"][number] {
  return { name, transport: "stdio", isBuiltIn: false, state }
}

/**
 * Builds the status of an HTTP server.
 *
 * @param name - Server name.
 * @param state - Its state.
 * @returns The status the list reports.
 */
function buildHttpStatus(
  name: string,
  state: McpServerState
): McpServerList["servers"][number] {
  return { name, transport: "http", isBuiltIn: false, state }
}

/**
 * Builds a server list.
 *
 * @param servers - Statuses in settings order.
 * @param settings - Outcome of the last settings read.
 * @returns The list.
 */
function buildList(
  servers: McpServerList["servers"],
  settings: McpServerList["settings"] = "applied"
): McpServerList {
  return { settings, servers }
}

/**
 * Waits until the registry lists exactly these servers, observing the list
 * again on each try without acting.
 *
 * @param registry - Registry under test.
 * @param expected - Expected list.
 * @param wait - How long and how often to look; {@link STATE_WAIT} when
 * omitted.
 */
async function waitForServerList(
  registry: McpServerRegistry,
  expected: McpServerList,
  wait: Readonly<{ timeout: number; interval: number }> = STATE_WAIT
): Promise<void> {
  await vi.waitFor(() => {
    expect(registry.listServers()).toEqual(expected)
  }, wait)
}

/**
 * Creates a registry harness whose only server, `alpha`, runs one copy at a
 * time, and waits until it is connected.
 *
 * @param serverFolder - Folder the server starts in, which holds its lock.
 * @returns The harness, with `alpha` connected.
 */
async function createConnectedOneCopyHarness(
  serverFolder: string
): Promise<RegistryHarness> {
  const harness = createRegistryHarness({ workingDirectory: serverFolder })
  harness.setServers([buildOneCopyServerSettings("alpha", [])])
  await harness.registry.updateServers()
  await waitForServerList(
    harness.registry,
    buildList([buildStdioStatus("alpha", buildConnectedState(1))])
  )
  return harness
}

/**
 * Finds a tool the case expects to be found.
 *
 * @param registry - Registry under test.
 * @param toolName - Model-facing tool name.
 * @returns The tool.
 * @throws When the lookup does not find it.
 */
function findTool(registry: McpServerRegistry, toolName: string): TurnMcpTool {
  const lookup = registry.findTurnTool(toolName)
  if (lookup.status !== "found")
    throw new Error(`Expected ${toolName} to be found, not ${lookup.status}.`)
  return lookup.tool
}

/**
 * Keeps the events of one kind.
 *
 * @param events - Reported events.
 * @param kind - Kind to keep.
 * @returns The events of that kind, in order.
 */
function filterEvents<Kind extends McpServerEvent["kind"]>(
  events: readonly McpServerEvent[],
  kind: Kind
): Extract<McpServerEvent, { kind: Kind }>[] {
  return events.filter(
    (event): event is Extract<McpServerEvent, { kind: Kind }> =>
      event.kind === kind
  )
}

/**
 * Finds the connection opened for one server.
 *
 * @param connections - Connections the openings ended with.
 * @param serverName - Server name.
 * @param index - Which of the server's connections, in the order the
 * openings ended.
 * @returns The connection.
 * @throws When no such connection was opened.
 */
function findOpenedConnection(
  connections: readonly OpenedConnection[],
  serverName: string,
  index = 0
): OpenedConnection {
  const connection = connections.filter(
    (opened) => opened.serverName === serverName
  )[index]
  if (connection === undefined)
    throw new Error(`No connection ${index} was opened for ${serverName}.`)
  return connection
}

/**
 * Waits until the registry asked a connection to close, and for that close
 * to end.
 *
 * @param opened - The connection.
 */
async function waitForRegistryClose(opened: OpenedConnection): Promise<void> {
  await vi.waitFor(() => {
    expect(opened.close).toHaveBeenCalledOnce()
  }, STATE_WAIT)
  const [result] = opened.close.mock.results
  if (result?.type !== "return")
    throw new Error("Closing the connection did not return a promise.")
  await result.value
}

describe("McpServerRegistry", { timeout: CASE_TIMEOUT_MILLISECONDS }, () => {
  describe("applying the settings", () => {
    it("lists no server and reads nothing before the settings are applied", () => {
      const { registry, readSettings, openServer } = createRegistryHarness()

      expect(registry.listServers()).toEqual(buildList([]))
      expect(registry.listToolDefinitions()).toEqual([])
      expect(readSettings).not.toHaveBeenCalled()
      expect(openServer).not.toHaveBeenCalled()
    })

    it("lists new servers as connecting in settings order, then each as connected or failed", async () => {
      const harness = createRegistryHarness()
      const cutServer = await startFakeMcpHttpServer(
        answerAsMcpServer(
          Array.from(
            { length: MAXIMUM_MCP_SERVER_TOOL_COUNT + 1 },
            (_, index) => buildTool(`tool-${index}`)
          )
        )
      )
      harness.setServers([
        buildFakeStdioServerSettings("alpha", {
          tools: [ECHO_TOOL, LOOK_DOT_UP_TOOL, LOOK_UNDERSCORE_UP_TOOL]
        }),
        buildFakeStdioServerSettings("beta", { exitOnStart: 3 }),
        buildHttpServerSettings("gamma", cutServer.url)
      ])
      const release = harness.holdOpenings()

      await harness.registry.updateServers()

      expect(harness.registry.listServers()).toEqual(
        buildList([
          buildStdioStatus("alpha", CONNECTING),
          buildStdioStatus("beta", CONNECTING),
          buildHttpStatus("gamma", CONNECTING)
        ])
      )
      expect(
        harness.openServer.mock.calls.map(([settings]) => settings.name)
      ).toEqual(["alpha", "beta", "gamma"])
      release()
      await waitForServerList(
        harness.registry,
        buildList([
          buildStdioStatus(
            "alpha",
            buildConnectedState(2, [
              { name: "look_up", reason: "duplicate-name" }
            ])
          ),
          buildStdioStatus("beta", buildFailedState("closed")),
          buildHttpStatus(
            "gamma",
            buildConnectedState(MAXIMUM_MCP_SERVER_TOOL_COUNT, [], true)
          )
        ])
      )
      const outcomeEvents = harness.events.filter(
        (event) => event.kind === "connected" || event.kind === "opening-failed"
      )
      expect(outcomeEvents).toHaveLength(3)
      expect(outcomeEvents).toEqual(
        expect.arrayContaining([
          {
            kind: "connected",
            serverName: "alpha",
            toolCount: 2,
            skippedToolCount: 1,
            isToolListCut: false
          },
          {
            kind: "opening-failed",
            serverName: "beta",
            reason: "closed",
            failure: { kind: "closed" },
            unknownError: undefined
          },
          {
            kind: "connected",
            serverName: "gamma",
            toolCount: MAXIMUM_MCP_SERVER_TOOL_COUNT,
            skippedToolCount: 0,
            isToolListCut: true
          }
        ])
      )
    })

    it("reports what a stdio server writes to standard error, from the working folder it starts in", async () => {
      const harness = createRegistryHarness()
      harness.setServers([
        buildFakeStdioServerSettings("alpha", { reportEnvironment: [] })
      ])

      await harness.registry.updateServers()

      await vi.waitFor(() => {
        expect(harness.events).toEqual(
          expect.arrayContaining([
            {
              kind: "server-log-line",
              serverName: "alpha",
              line: "fake server started"
            },
            {
              kind: "server-log-line",
              serverName: "alpha",
              line: `cwd ${WORKING_DIRECTORY}`
            }
          ])
        )
      }, STATE_WAIT)
    })

    it("keeps the connection or failure of a server whose settings did not change", async () => {
      const harness = createRegistryHarness()
      harness.setServers([
        buildFakeStdioServerSettings("alpha"),
        buildFakeStdioServerSettings("beta", { exitOnStart: 3 })
      ])
      await harness.registry.updateServers()
      const settledList = buildList([
        buildStdioStatus("alpha", buildConnectedState(1)),
        buildStdioStatus("beta", buildFailedState("closed"))
      ])
      await waitForServerList(harness.registry, settledList)

      await harness.registry.updateServers()

      expect(harness.registry.listServers()).toEqual(settledList)
      expect(harness.readSettings).toHaveBeenCalledTimes(2)
      expect(harness.openServer).toHaveBeenCalledTimes(2)
      expect(
        findOpenedConnection(harness.openedConnections, "alpha").close
      ).not.toHaveBeenCalled()
      await expect(
        findTool(harness.registry, "mcp__alpha__echo").sendToolCall(
          { text: "still here" },
          NEVER_ABORTED
        )
      ).resolves.toMatchObject({
        status: "succeeded",
        content: expect.stringContaining('echo: {"text":"still here"}')
      })
    })

    it("closes and opens again a server whose settings changed", async () => {
      const harness = createRegistryHarness()
      harness.setServers([buildFakeStdioServerSettings("alpha")])
      await harness.registry.updateServers()
      await waitForServerList(
        harness.registry,
        buildList([buildStdioStatus("alpha", buildConnectedState(1))])
      )
      const changedSettings = buildFakeStdioServerSettings("alpha", {}, [
        { name: "LYS_TEST_MODE", value: "changed" }
      ])
      harness.setServers([changedSettings])

      await harness.registry.updateServers()

      expect(harness.registry.listServers()).toEqual(
        buildList([buildStdioStatus("alpha", CONNECTING)])
      )
      const first = findOpenedConnection(harness.openedConnections, "alpha")
      await waitForRegistryClose(first)
      await expect(
        first.connection.sendToolCall("echo", { text: "x" }, NEVER_ABORTED)
      ).rejects.toThrow()
      await waitForServerList(
        harness.registry,
        buildList([buildStdioStatus("alpha", buildConnectedState(1))])
      )
      expect(harness.openServer).toHaveBeenCalledTimes(2)
      expect(harness.openServer.mock.calls[1]?.[0]).toEqual(changedSettings)
      expect(filterEvents(harness.events, "connection-closed")).toEqual([])
    })

    it("opens a changed command server only once its previous process ended, so a server that runs one copy at a time connects", async () => {
      const harness = await createConnectedOneCopyHarness(createServerFolder())
      const changedSettings = buildOneCopyServerSettings("alpha", [
        { name: "LYS_TEST_MODE", value: "changed" }
      ])
      harness.setServers([changedSettings])

      await harness.registry.updateServers()
      await waitForMicrotasks()

      expect(harness.registry.listServers()).toEqual(
        buildList([buildStdioStatus("alpha", CONNECTING)])
      )
      expect(harness.openServer).toHaveBeenCalledOnce()
      await waitForServerList(
        harness.registry,
        buildList([buildStdioStatus("alpha", buildConnectedState(1))])
      )
      expect(harness.openServer.mock.calls[1]?.[0]).toEqual(changedSettings)
      expect(filterEvents(harness.events, "opening-failed")).toEqual([])
    })

    it("opens a renamed command server only once the process of its old name ended, so a server that runs one copy at a time connects", async () => {
      const harness = await createConnectedOneCopyHarness(createServerFolder())
      const renamedSettings = buildOneCopyServerSettings("beta", [])
      harness.setServers([renamedSettings])

      await harness.registry.updateServers()
      await waitForMicrotasks()

      expect(harness.registry.listServers()).toEqual(
        buildList([buildStdioStatus("beta", CONNECTING)])
      )
      expect(harness.openServer).toHaveBeenCalledOnce()
      await waitForServerList(
        harness.registry,
        buildList([buildStdioStatus("beta", buildConnectedState(1))])
      )
      expect(harness.openServer.mock.calls[1]?.[0]).toEqual(renamedSettings)
      expect(filterEvents(harness.events, "opening-failed")).toEqual([])
    })

    it("opens a command server named again only once the process of its removed session ended, so a server that runs one copy at a time connects", async () => {
      const harness = await createConnectedOneCopyHarness(createServerFolder())
      harness.setServers([])
      await harness.registry.updateServers()
      harness.setServers([buildOneCopyServerSettings("alpha", [])])

      await harness.registry.updateServers()
      await waitForMicrotasks()

      expect(harness.registry.listServers()).toEqual(
        buildList([buildStdioStatus("alpha", CONNECTING)])
      )
      expect(harness.openServer).toHaveBeenCalledOnce()
      await waitForServerList(
        harness.registry,
        buildList([buildStdioStatus("alpha", buildConnectedState(1))])
      )
      expect(harness.openServer).toHaveBeenCalledTimes(2)
      expect(filterEvents(harness.events, "opening-failed")).toEqual([])
    })

    it("opens the changed servers of a group only once every server it stopped released, whatever their order", async () => {
      const betaClose = Promise.withResolvers<void>()
      const harness = createRegistryHarness({
        open: async (settings, context, testEnded) => {
          const opening = await openFakeServer(settings, context)
          if (opening.status === "connected" && settings.name === "beta")
            holdCloseUntil(
              opening.connection,
              Promise.race([betaClose.promise, testEnded])
            )
          return opening
        }
      })
      const one = { name: "LYS_TEST_MODE", value: "one" }
      const two = { name: "LYS_TEST_MODE", value: "two" }
      harness.setServers([
        buildFakeStdioServerSettings("alpha", {}, [one]),
        buildFakeStdioServerSettings("beta", {}, [two])
      ])
      await harness.registry.updateServers()
      await waitForServerList(
        harness.registry,
        buildList([
          buildStdioStatus("alpha", buildConnectedState(1)),
          buildStdioStatus("beta", buildConnectedState(1))
        ])
      )
      harness.setServers([
        buildFakeStdioServerSettings("alpha", {}, [two]),
        buildFakeStdioServerSettings("beta", {}, [one])
      ])

      await harness.registry.updateServers()
      await waitForRegistryClose(
        findOpenedConnection(harness.openedConnections, "alpha")
      )
      await waitForMicrotasks()

      expect(harness.openServer).toHaveBeenCalledTimes(2)
      expect(harness.registry.listServers()).toEqual(
        buildList([
          buildStdioStatus("alpha", CONNECTING),
          buildStdioStatus("beta", CONNECTING)
        ])
      )
      betaClose.resolve()
      await waitForServerList(
        harness.registry,
        buildList([
          buildStdioStatus("alpha", buildConnectedState(1)),
          buildStdioStatus("beta", buildConnectedState(1))
        ])
      )
      expect(harness.openServer).toHaveBeenCalledTimes(4)
    })

    it("closes a server the settings no longer name", async () => {
      const harness = createRegistryHarness()
      harness.setServers([
        buildFakeStdioServerSettings("alpha"),
        buildFakeStdioServerSettings("beta")
      ])
      await harness.registry.updateServers()
      await waitForServerList(
        harness.registry,
        buildList([
          buildStdioStatus("alpha", buildConnectedState(1)),
          buildStdioStatus("beta", buildConnectedState(1))
        ])
      )
      harness.setServers([buildFakeStdioServerSettings("beta")])

      await harness.registry.updateServers()

      expect(harness.registry.listServers()).toEqual(
        buildList([buildStdioStatus("beta", buildConnectedState(1))])
      )
      expect(
        harness.registry.listToolDefinitions().map((tool) => tool.name)
      ).toEqual(["mcp__beta__echo"])
      expect(harness.registry.findTurnTool("mcp__alpha__echo")).toEqual({
        status: "unknown"
      })
      await waitForRegistryClose(
        findOpenedConnection(harness.openedConnections, "alpha")
      )
      expect(
        findOpenedConnection(harness.openedConnections, "beta").close
      ).not.toHaveBeenCalled()
      expect(filterEvents(harness.events, "connection-closed")).toEqual([])
    })

    it("keeps the applied servers when the settings fail their rules or cannot be read", async () => {
      const harness = createRegistryHarness()
      harness.setServers([buildFakeStdioServerSettings("alpha")])
      await harness.registry.updateServers()
      const connected = [buildStdioStatus("alpha", buildConnectedState(1))]
      await waitForServerList(harness.registry, buildList(connected))
      const problems = ["servers.0.command: A command is 1 to 4096 characters."]

      harness.setSettingsRead({ status: "invalid", problems })
      await harness.registry.updateServers()
      const afterInvalid = harness.registry.listServers()
      harness.setSettingsRead({ status: "unreadable" })
      await harness.registry.updateServers()
      const afterUnreadable = harness.registry.listServers()
      harness.setServers([buildFakeStdioServerSettings("alpha")])
      await harness.registry.updateServers()

      expect(afterInvalid).toEqual(buildList(connected, "invalid"))
      expect(afterUnreadable).toEqual(buildList(connected, "unreadable"))
      expect(harness.registry.listServers()).toEqual(buildList(connected))
      expect(harness.openServer).toHaveBeenCalledOnce()
      expect(
        harness.events.filter((event) => event.kind.startsWith("settings-"))
      ).toEqual([
        { kind: "settings-invalid", problems },
        { kind: "settings-unreadable" }
      ])
    })

    it("reads the settings one after another in call order", async () => {
      const reads = [
        Promise.withResolvers<McpSettingsRead>(),
        Promise.withResolvers<McpSettingsRead>()
      ]
      const harness = createRegistryHarness({
        readSettings: (testEnded) => {
          const read = reads.shift()
          if (read === undefined)
            throw new Error("Only two reads are expected.")
          return Promise.race([
            read.promise,
            testEnded.then(() => buildSettingsRead([]))
          ])
        }
      })
      const [firstRead, secondRead] = reads
      if (firstRead === undefined || secondRead === undefined)
        throw new Error("The reads were not created.")
      harness.holdOpenings()

      const first = harness.registry.updateServers()
      const second = harness.registry.updateServers()
      await waitForMicrotasks()
      const readsBeforeFirstAnswer = harness.readSettings.mock.calls.length
      firstRead.resolve(
        buildSettingsRead([buildFakeStdioServerSettings("alpha")])
      )
      await first
      const listAfterFirst = harness.registry.listServers()
      await waitForMicrotasks()
      const readsBeforeSecondAnswer = harness.readSettings.mock.calls.length
      secondRead.resolve(buildSettingsRead([]))
      await second

      expect(readsBeforeFirstAnswer).toBe(1)
      expect(listAfterFirst).toEqual(
        buildList([buildStdioStatus("alpha", CONNECTING)])
      )
      expect(readsBeforeSecondAnswer).toBe(2)
      expect(harness.registry.listServers()).toEqual(buildList([]))
      expect(harness.openServer.mock.calls[0]?.[1].abortSignal.aborted).toBe(
        true
      )
    })

    it("rejects the apply whose read throws, and still runs the next read", async () => {
      const failure = new Error("Closing the settings file failed.")
      const outcomes: (() => Promise<McpSettingsRead>)[] = [
        () => Promise.reject(failure),
        () => Promise.resolve({ status: "unreadable" })
      ]
      const harness = createRegistryHarness({
        readSettings: () => {
          const outcome = outcomes.shift()
          if (outcome === undefined)
            throw new Error("Only two reads are expected.")
          return outcome()
        }
      })

      const failing = harness.registry.updateServers()
      const next = harness.registry.updateServers()

      await expect(failing).rejects.toBe(failure)
      await expect(next).resolves.toBeUndefined()
      expect(harness.registry.listServers()).toEqual(
        buildList([], "unreadable")
      )
    })

    it("fails a server as protocol-error when its opening rejects", async () => {
      const defect = new Error("The opener has a defect.")
      const harness = createRegistryHarness({
        open: () => Promise.reject(defect)
      })
      harness.setServers([buildFakeStdioServerSettings("alpha")])

      await harness.registry.updateServers()

      await waitForServerList(
        harness.registry,
        buildList([
          buildStdioStatus("alpha", buildFailedState("protocol-error"))
        ])
      )
      expect(filterEvents(harness.events, "opening-failed")).toEqual([
        {
          kind: "opening-failed",
          serverName: "alpha",
          reason: "protocol-error",
          failure: { kind: "unknown" },
          unknownError: defect
        }
      ])
    })
  })

  describe("connection ends", () => {
    it("fails a connected server as closed when its connection ends by itself", async () => {
      const harness = createRegistryHarness()
      harness.setServers([
        buildFakeStdioServerSettings("alpha", { tools: [ECHO_TOOL, EXIT_TOOL] })
      ])
      await harness.registry.updateServers()
      await waitForServerList(
        harness.registry,
        buildList([buildStdioStatus("alpha", buildConnectedState(2))])
      )

      const outcome = await findTool(
        harness.registry,
        "mcp__alpha__exit"
      ).sendToolCall({}, NEVER_ABORTED)

      expect(outcome).toEqual({
        status: "failed",
        content:
          "The call of mcp__alpha__exit failed: the connection to the MCP server alpha ended. The person can reconnect it in Settings → MCP."
      })
      await waitForServerList(
        harness.registry,
        buildList([buildStdioStatus("alpha", buildFailedState("closed"))])
      )
      expect(filterEvents(harness.events, "connection-closed")).toEqual([
        { kind: "connection-closed", serverName: "alpha" }
      ])
      expect(harness.registry.listToolDefinitions()).toEqual([])
      expect(harness.registry.findTurnTool("mcp__alpha__echo")).toEqual({
        status: "not-connected"
      })
      await waitForRegistryClose(
        findOpenedConnection(harness.openedConnections, "alpha")
      )
      expect(harness.openServer).toHaveBeenCalledOnce()
    })

    it("fails a connected server as closed once it answers a call with HTTP 404, which ends its session", async () => {
      const server = await startFakeMcpHttpServer(
        answerToolCallsWith((_id, response) => {
          response.writeHead(404)
          response.end("Session not found")
        })
      )
      const harness = createRegistryHarness()
      harness.setServers([buildHttpServerSettings("remote", server.url)])
      await harness.registry.updateServers()
      await waitForServerList(
        harness.registry,
        buildList([buildHttpStatus("remote", buildConnectedState(1))])
      )

      const outcome = await findTool(
        harness.registry,
        "mcp__remote__echo"
      ).sendToolCall({}, NEVER_ABORTED)

      expect(outcome).toEqual({
        status: "failed",
        content:
          "The call of mcp__remote__echo failed: the MCP server remote answered with HTTP status 404."
      })
      await waitForServerList(
        harness.registry,
        buildList([buildHttpStatus("remote", buildFailedState("closed"))])
      )
      expect(filterEvents(harness.events, "connection-closed")).toEqual([
        { kind: "connection-closed", serverName: "remote" }
      ])
      await waitForRegistryClose(
        findOpenedConnection(harness.openedConnections, "remote")
      )
    })

    it("reports a session an HTTP server does not end as its removed entry closes", async () => {
      const answer = answerAsMcpServer()
      const server = await startFakeMcpHttpServer((request, body, response) => {
        if (request.method === "DELETE")
          answerWithStatus(500)(request, body, response)
        else answer(request, body, response)
      })
      const harness = createRegistryHarness()
      harness.setServers([buildHttpServerSettings("remote", server.url)])
      await harness.registry.updateServers()
      await waitForServerList(
        harness.registry,
        buildList([buildHttpStatus("remote", buildConnectedState(1))])
      )

      harness.setServers([])
      await harness.registry.updateServers()
      await waitForRegistryClose(
        findOpenedConnection(harness.openedConnections, "remote")
      )

      expect(filterEvents(harness.events, "session-end-failed")).toEqual([
        {
          kind: "session-end-failed",
          serverName: "remote",
          error: expect.objectContaining({ data: { status: 500 } })
        }
      ])
      expect(harness.registry.listServers()).toEqual(buildList([]))
    })

    it("fails a server as closed when its connection ends before its opening is recorded", async () => {
      const exitCalls: Promise<unknown>[] = []
      const harness = createRegistryHarness({
        open: async (settings, context) => {
          const ended = Promise.withResolvers<void>()
          const opening = await openFakeServer(settings, {
            ...context,
            reportConnectionClosed: () => {
              ended.resolve()
              context.reportConnectionClosed()
            }
          })
          if (opening.status !== "connected") return opening
          const exitCall = opening.connection.sendToolCall(
            "exit",
            {},
            NEVER_ABORTED
          )
          exitCalls.push(exitCall)
          await Promise.allSettled([exitCall, ended.promise])
          return opening
        }
      })
      harness.setServers([buildFakeStdioServerSettings("alpha")])

      await harness.registry.updateServers()

      await waitForServerList(
        harness.registry,
        buildList([buildStdioStatus("alpha", buildFailedState("closed"))])
      )
      await expect(exitCalls[0]).rejects.toThrow()
      expect(filterEvents(harness.events, "connected")).toEqual([])
      expect(filterEvents(harness.events, "connection-closed")).toEqual([
        { kind: "connection-closed", serverName: "alpha" }
      ])
      await waitForRegistryClose(
        findOpenedConnection(harness.openedConnections, "alpha")
      )
    })
  })

  describe("reconnect", () => {
    it("answers not-found for a name no applied server has, and opens nothing", async () => {
      const harness = createRegistryHarness()
      harness.setServers([buildFakeStdioServerSettings("alpha")])
      harness.holdOpenings()
      await harness.registry.updateServers()

      expect(harness.registry.openServerAgain("ghost")).toBe("not-found")
      expect(harness.registry.openServerAgain("alpha-2")).toBe("not-found")
      expect(harness.openServer).toHaveBeenCalledOnce()
      expect(harness.openServer.mock.calls[0]?.[1].abortSignal.aborted).toBe(
        false
      )
    })

    it("closes a connected server and opens it again with its applied settings", async () => {
      const harness = createRegistryHarness()
      const settings = buildFakeStdioServerSettings("alpha")
      harness.setServers([settings])
      await harness.registry.updateServers()
      await waitForServerList(
        harness.registry,
        buildList([buildStdioStatus("alpha", buildConnectedState(1))])
      )

      expect(harness.registry.openServerAgain("alpha")).toBe("reconnecting")

      expect(harness.registry.listServers()).toEqual(
        buildList([buildStdioStatus("alpha", CONNECTING)])
      )
      await waitForRegistryClose(
        findOpenedConnection(harness.openedConnections, "alpha")
      )
      await waitForServerList(
        harness.registry,
        buildList([buildStdioStatus("alpha", buildConnectedState(1))])
      )
      expect(harness.readSettings).toHaveBeenCalledOnce()
      expect(harness.openServer.mock.calls.map(([opened]) => opened)).toEqual([
        settings,
        settings
      ])
      expect(filterEvents(harness.events, "connection-closed")).toEqual([])
    })

    it("opens a command server again only once its previous process ended, so a server that runs one copy at a time connects", async () => {
      const harness = await createConnectedOneCopyHarness(createServerFolder())

      expect(harness.registry.openServerAgain("alpha")).toBe("reconnecting")
      await waitForMicrotasks()

      expect(harness.registry.listServers()).toEqual(
        buildList([buildStdioStatus("alpha", CONNECTING)])
      )
      expect(harness.openServer).toHaveBeenCalledOnce()
      await waitForServerList(
        harness.registry,
        buildList([buildStdioStatus("alpha", buildConnectedState(1))])
      )
      expect(harness.openServer).toHaveBeenCalledTimes(2)
      expect(filterEvents(harness.events, "opening-failed")).toEqual([])
    })

    it("opens a server a launcher runs again only once every process of its old group ended, even one that ignores its closed input and SIGTERM", async () => {
      const port = Number(new URL(await findClosedMcpUrl()).port)
      const harness = createRegistryHarness()
      harness.setServers([
        buildFakeLauncherServerSettings("alpha", {
          holdPort: port,
          ignoreSigterm: true
        })
      ])
      await harness.registry.updateServers()
      await waitForServerList(
        harness.registry,
        buildList([buildStdioStatus("alpha", buildConnectedState(1))])
      )

      expect(harness.registry.openServerAgain("alpha")).toBe("reconnecting")

      await waitForServerList(
        harness.registry,
        buildList([buildStdioStatus("alpha", buildConnectedState(1))]),
        LAUNCHER_STATE_WAIT
      )
      expect(harness.openServer).toHaveBeenCalledTimes(2)
      expect(filterEvents(harness.events, "opening-failed")).toEqual([])
    })

    it("opens a server reconnected twice while its previous process ends only once", async () => {
      const harness = await createConnectedOneCopyHarness(createServerFolder())

      expect(harness.registry.openServerAgain("alpha")).toBe("reconnecting")
      expect(harness.registry.openServerAgain("alpha")).toBe("reconnecting")

      await waitForServerList(
        harness.registry,
        buildList([buildStdioStatus("alpha", buildConnectedState(1))])
      )
      expect(harness.openServer).toHaveBeenCalledTimes(2)
      expect(filterEvents(harness.events, "opening-failed")).toEqual([])
    })

    it("opens nothing for a server removed while its previous process ends", async () => {
      const harness = await createConnectedOneCopyHarness(createServerFolder())
      expect(harness.registry.openServerAgain("alpha")).toBe("reconnecting")
      harness.setServers([])

      await harness.registry.updateServers()
      await harness.registry.close()

      expect(harness.openServer).toHaveBeenCalledOnce()
      expect(harness.registry.listServers()).toEqual(buildList([]))
    })

    it("opens nothing when the registry closes while a reconnected server's previous process ends, and waits for that process", async () => {
      const serverFolder = createServerFolder()
      const harness = await createConnectedOneCopyHarness(serverFolder)
      expect(harness.registry.openServerAgain("alpha")).toBe("reconnecting")

      await harness.registry.close()

      expect(harness.openServer).toHaveBeenCalledOnce()
      expect(
        findOpenedConnection(harness.openedConnections, "alpha").close
      ).toHaveBeenCalledOnce()
      expect(readdirSync(serverFolder)).toEqual([])
    })

    it("opens a failed server again, which connects once the server answers", async () => {
      let route: McpHttpRoute = answerWithStatus(401)
      const server = await startFakeMcpHttpServer((request, body, response) => {
        route(request, body, response)
      })
      const harness = createRegistryHarness()
      harness.setServers([buildHttpServerSettings("remote", server.url)])
      await harness.registry.updateServers()
      await waitForServerList(
        harness.registry,
        buildList([buildHttpStatus("remote", buildFailedState("unauthorized"))])
      )
      route = answerAsMcpServer()

      expect(harness.registry.openServerAgain("remote")).toBe("reconnecting")

      expect(harness.registry.listServers()).toEqual(
        buildList([buildHttpStatus("remote", CONNECTING)])
      )
      await waitForServerList(
        harness.registry,
        buildList([buildHttpStatus("remote", buildConnectedState(1))])
      )
      expect(filterEvents(harness.events, "opening-failed")).toEqual([
        {
          kind: "opening-failed",
          serverName: "remote",
          reason: "unauthorized",
          failure: { kind: "http-status", status: 401 },
          unknownError: undefined
        }
      ])
    })

    it("cancels an opening it supersedes, and opens again only once the connection that opening still ends with closed", async () => {
      const lateRelease = Promise.withResolvers<void>()
      const closeRelease = Promise.withResolvers<void>()
      let openingCount = 0
      const harness = createRegistryHarness({
        open: async (settings, context, testEnded) => {
          openingCount += 1
          if (openingCount > 1) return openFakeServer(settings, context)
          // Opens without the registry's signal, like an opener that
          // connected before it saw the cancellation.
          const opening = await openFakeServer(settings, {
            ...context,
            abortSignal: NEVER_ABORTED
          })
          await Promise.race([lateRelease.promise, testEnded])
          if (opening.status === "connected")
            holdCloseUntil(
              opening.connection,
              Promise.race([closeRelease.promise, testEnded])
            )
          return opening
        }
      })
      harness.setServers([buildFakeStdioServerSettings("alpha")])
      await harness.registry.updateServers()

      expect(harness.registry.openServerAgain("alpha")).toBe("reconnecting")

      expect(harness.openServer.mock.calls[0]?.[1].abortSignal.aborted).toBe(
        true
      )
      lateRelease.resolve()
      await vi.waitFor(() => {
        expect(
          findOpenedConnection(harness.openedConnections, "alpha").close
        ).toHaveBeenCalledOnce()
      }, STATE_WAIT)
      await waitForMicrotasks()
      expect(harness.openServer).toHaveBeenCalledOnce()
      expect(harness.registry.listServers()).toEqual(
        buildList([buildStdioStatus("alpha", CONNECTING)])
      )
      closeRelease.resolve()
      await waitForServerList(
        harness.registry,
        buildList([buildStdioStatus("alpha", buildConnectedState(1))])
      )
      expect(harness.openServer).toHaveBeenCalledTimes(2)
      expect(
        findOpenedConnection(harness.openedConnections, "alpha", 1).close
      ).not.toHaveBeenCalled()
      expect(filterEvents(harness.events, "connected")).toHaveLength(1)
      await expect(
        findTool(harness.registry, "mcp__alpha__echo").sendToolCall(
          { text: "current" },
          NEVER_ABORTED
        )
      ).resolves.toMatchObject({ status: "succeeded" })
    })

    it("tells the model the server was restarted or reconnected when a reconnect stops its session while a call runs", async () => {
      const harness = createRegistryHarness()
      harness.setServers([
        buildFakeStdioServerSettings("alpha", { tools: [ECHO_TOOL, SLOW_TOOL] })
      ])
      await harness.registry.updateServers()
      await waitForServerList(
        harness.registry,
        buildList([buildStdioStatus("alpha", buildConnectedState(2))])
      )
      const call = findTool(harness.registry, "mcp__alpha__slow").sendToolCall(
        {},
        NEVER_ABORTED
      )
      await waitForMicrotasks()

      expect(harness.registry.openServerAgain("alpha")).toBe("reconnecting")
      const outcome = await call

      expect(outcome).toEqual({
        status: "failed",
        content:
          "The call of mcp__alpha__slow failed: the MCP server alpha was stopped while the call ran: it was restarted or reconnected in Settings → MCP."
      })
      expect(filterEvents(harness.events, "tool-call-failed")).toEqual([
        {
          kind: "tool-call-failed",
          serverName: "alpha",
          serverToolName: "slow",
          failure: { kind: "closed" },
          unknownError: undefined
        }
      ])
    })
  })

  describe("tool lookup", () => {
    it("lists the tools of the connected servers in settings order", async () => {
      const harness = createRegistryHarness()
      harness.setServers([
        buildFakeStdioServerSettings("alpha", {
          tools: [ECHO_TOOL, LOOK_DOT_UP_TOOL]
        }),
        buildFakeStdioServerSettings("beta", { exitOnStart: 3 }),
        buildFakeStdioServerSettings("gamma")
      ])
      await harness.registry.updateServers()
      await waitForServerList(
        harness.registry,
        buildList([
          buildStdioStatus("alpha", buildConnectedState(2)),
          buildStdioStatus("beta", buildFailedState("closed")),
          buildStdioStatus("gamma", buildConnectedState(1))
        ])
      )

      const definitions = harness.registry.listToolDefinitions()

      expect(definitions).toEqual([
        {
          name: "mcp__alpha__echo",
          description: "Echoes its arguments.",
          group: "mcp",
          access: "unknown",
          runner: "mcp",
          server: "alpha",
          serverToolName: "echo",
          inputSchema: ECHO_TOOL.inputSchema
        },
        expect.objectContaining({
          name: "mcp__alpha__look_up",
          server: "alpha",
          serverToolName: "look.up"
        }),
        expect.objectContaining({
          name: "mcp__gamma__echo",
          server: "gamma",
          serverToolName: "echo"
        })
      ])
    })

    it("finds a listed tool of a connected server, and tells a server that is not connected from an unknown name", async () => {
      const harness = createRegistryHarness()
      harness.setServers([
        buildFakeStdioServerSettings("alpha", {
          tools: [ECHO_TOOL, LOOK_DOT_UP_TOOL]
        }),
        buildFakeStdioServerSettings("beta", { exitOnStart: 3 })
      ])
      await harness.registry.updateServers()
      await waitForServerList(
        harness.registry,
        buildList([
          buildStdioStatus("alpha", buildConnectedState(2)),
          buildStdioStatus("beta", buildFailedState("closed"))
        ])
      )
      harness.holdOpenings()
      harness.setServers([
        buildFakeStdioServerSettings("alpha", {
          tools: [ECHO_TOOL, LOOK_DOT_UP_TOOL]
        }),
        buildFakeStdioServerSettings("beta", { exitOnStart: 3 }),
        buildFakeStdioServerSettings("delta")
      ])
      await harness.registry.updateServers()
      const unknownNames = [
        "echo",
        "read_page",
        "mcp__ghost__echo",
        "mcp__alpha__missing",
        "mcp__alpha",
        "mcp____echo",
        "mcp__alpha_echo"
      ]

      const found = harness.registry.findTurnTool("mcp__alpha__look_up")

      expect(found).toEqual({
        status: "found",
        tool: {
          definition: harness.registry.listToolDefinitions()[1],
          sendToolCall: expect.any(Function)
        }
      })
      expect(harness.registry.findTurnTool("mcp__beta__echo")).toEqual({
        status: "not-connected"
      })
      expect(harness.registry.findTurnTool("mcp__delta__echo")).toEqual({
        status: "not-connected"
      })
      expect(
        unknownNames.map((name) => harness.registry.findTurnTool(name))
      ).toEqual(unknownNames.map(() => ({ status: "unknown" })))
    })
  })

  describe("tool calls", () => {
    it("returns the server's result, failed when the tool reports a failure", async () => {
      const harness = createRegistryHarness()
      harness.setServers([
        buildFakeStdioServerSettings("alpha", { tools: [ECHO_TOOL, FAIL_TOOL] })
      ])
      await harness.registry.updateServers()
      await waitForServerList(
        harness.registry,
        buildList([buildStdioStatus("alpha", buildConnectedState(2))])
      )

      const echoed = await findTool(
        harness.registry,
        "mcp__alpha__echo"
      ).sendToolCall({ text: "hi" }, NEVER_ABORTED)
      const failed = await findTool(
        harness.registry,
        "mcp__alpha__fail"
      ).sendToolCall({}, NEVER_ABORTED)

      expect(echoed).toEqual({
        status: "succeeded",
        content: expect.stringContaining('echo: {"text":"hi"}')
      })
      expect(failed).toEqual({
        status: "failed",
        content: expect.stringContaining("it broke")
      })
      expect(filterEvents(harness.events, "tool-call-failed")).toEqual([])
    })

    it("tells the model the server is not connected when it is not connected at call time, and reports the call as not sent", async () => {
      const harness = createRegistryHarness()
      harness.setServers([buildFakeStdioServerSettings("alpha")])
      await harness.registry.updateServers()
      await waitForServerList(
        harness.registry,
        buildList([buildStdioStatus("alpha", buildConnectedState(1))])
      )
      const tool = findTool(harness.registry, "mcp__alpha__echo")
      harness.holdOpenings()
      harness.registry.openServerAgain("alpha")

      const outcome = await tool.sendToolCall({ text: "hi" }, NEVER_ABORTED)

      expect(outcome).toEqual({
        status: "failed",
        content:
          "The call of mcp__alpha__echo failed: the MCP server alpha is not connected now. The person can reconnect it in Settings → MCP."
      })
      expect(filterEvents(harness.events, "tool-call-not-sent")).toEqual([
        {
          kind: "tool-call-not-sent",
          serverName: "alpha",
          serverToolName: "echo",
          reason: "server-not-connected"
        }
      ])
    })

    it("tells the model the server is not connected when the settings no longer name it at call time, and reports the call as not sent", async () => {
      const harness = createRegistryHarness()
      harness.setServers([buildFakeStdioServerSettings("alpha")])
      await harness.registry.updateServers()
      await waitForServerList(
        harness.registry,
        buildList([buildStdioStatus("alpha", buildConnectedState(1))])
      )
      const tool = findTool(harness.registry, "mcp__alpha__echo")
      harness.setServers([])
      await harness.registry.updateServers()

      const outcome = await tool.sendToolCall({ text: "hi" }, NEVER_ABORTED)

      expect(outcome).toEqual({
        status: "failed",
        content:
          "The call of mcp__alpha__echo failed: the MCP server alpha is not connected now. The person can reconnect it in Settings → MCP."
      })
      expect(filterEvents(harness.events, "tool-call-not-sent")).toEqual([
        {
          kind: "tool-call-not-sent",
          serverName: "alpha",
          serverToolName: "echo",
          reason: "server-not-connected"
        }
      ])
      expect(filterEvents(harness.events, "tool-call-failed")).toEqual([])
    })

    it("tells the model the server no longer lists the tool it was offered, and reports the call as not sent", async () => {
      const harness = createRegistryHarness()
      harness.setServers([
        buildFakeStdioServerSettings("alpha", {
          tools: [ECHO_TOOL, FAIL_TOOL, LOOK_DOT_UP_TOOL]
        })
      ])
      await harness.registry.updateServers()
      await waitForServerList(
        harness.registry,
        buildList([buildStdioStatus("alpha", buildConnectedState(3))])
      )
      const removedTool = findTool(harness.registry, "mcp__alpha__fail")
      const renamedTool = findTool(harness.registry, "mcp__alpha__look_up")
      harness.setServers([
        buildFakeStdioServerSettings("alpha", {
          tools: [ECHO_TOOL, LOOK_UNDERSCORE_UP_TOOL]
        })
      ])
      await harness.registry.updateServers()
      await waitForServerList(
        harness.registry,
        buildList([buildStdioStatus("alpha", buildConnectedState(2))])
      )

      const removedOutcome = await removedTool.sendToolCall({}, NEVER_ABORTED)
      const renamedOutcome = await renamedTool.sendToolCall({}, NEVER_ABORTED)

      expect(removedOutcome).toEqual({
        status: "failed",
        content:
          "The call of mcp__alpha__fail failed: the MCP server alpha no longer lists this tool."
      })
      expect(renamedOutcome).toEqual({
        status: "failed",
        content:
          "The call of mcp__alpha__look_up failed: the MCP server alpha no longer lists this tool."
      })
      expect(filterEvents(harness.events, "tool-call-not-sent")).toEqual([
        {
          kind: "tool-call-not-sent",
          serverName: "alpha",
          serverToolName: "fail",
          reason: "tool-no-longer-listed"
        },
        {
          kind: "tool-call-not-sent",
          serverName: "alpha",
          serverToolName: "look.up",
          reason: "tool-no-longer-listed"
        }
      ])
    })

    it("reports a call that failed before a result, and tells the model why", async () => {
      const harness = createRegistryHarness()
      harness.setServers([
        buildFakeStdioServerSettings("alpha", {
          tools: [ECHO_TOOL, REFUSE_TOOL]
        })
      ])
      await harness.registry.updateServers()
      await waitForServerList(
        harness.registry,
        buildList([buildStdioStatus("alpha", buildConnectedState(2))])
      )

      const outcome = await findTool(
        harness.registry,
        "mcp__alpha__refuse"
      ).sendToolCall({}, NEVER_ABORTED)

      expect(outcome.status).toBe("failed")
      expect(outcome.content).toMatch(
        /^The call of mcp__alpha__refuse failed: the MCP server alpha refused it with this untrusted message: [^\n]*bad[^\n]*$/u
      )
      expect(outcome.content).not.toContain("<<<end of mcp result>>>")
      expect(filterEvents(harness.events, "tool-call-failed")).toEqual([
        {
          kind: "tool-call-failed",
          serverName: "alpha",
          serverToolName: "refuse",
          failure: {
            kind: "refused",
            message: expect.stringContaining("<<<end of mcp result>>>")
          },
          unknownError: undefined
        }
      ])
    })

    it("rejects a call only once its signal aborted, and tells the server it was cancelled", async () => {
      const harness = createRegistryHarness()
      harness.setServers([
        buildFakeStdioServerSettings("alpha", { tools: [ECHO_TOOL, SLOW_TOOL] })
      ])
      await harness.registry.updateServers()
      await waitForServerList(
        harness.registry,
        buildList([buildStdioStatus("alpha", buildConnectedState(2))])
      )
      const controller = new AbortController()
      const call = findTool(harness.registry, "mcp__alpha__slow").sendToolCall(
        {},
        controller.signal
      )
      const settlement = createSettlementReader(call)
      await waitForMicrotasks()
      const settlementBeforeAbort = settlement()

      controller.abort()

      expect(settlementBeforeAbort).toBe("pending")
      await expect(call).rejects.toThrow()
      await vi.waitFor(() => {
        expect(filterEvents(harness.events, "server-log-line")).toContainEqual({
          kind: "server-log-line",
          serverName: "alpha",
          line: expect.stringMatching(/^cancelled /u)
        })
      }, STATE_WAIT)
      expect(filterEvents(harness.events, "tool-call-failed")).toEqual([])
      expect(harness.registry.listServers()).toEqual(
        buildList([buildStdioStatus("alpha", buildConnectedState(2))])
      )
    })
  })

  describe("switches and built-in servers", () => {
    it("lists a switched-off added server as off, opens nothing for it, offers none of its tools, and answers not-connected for them", async () => {
      const harness = createRegistryHarness()
      harness.setServers([
        buildSwitchedOffSettings(buildFakeStdioServerSettings("alpha")),
        buildFakeStdioServerSettings("beta")
      ])

      await harness.registry.updateServers()

      expect(harness.registry.listServers()).toEqual(
        buildList([
          buildStdioStatus("alpha", OFF),
          buildStdioStatus("beta", CONNECTING)
        ])
      )
      expect(
        harness.openServer.mock.calls.map(([settings]) => settings.name)
      ).toEqual(["beta"])
      await waitForServerList(
        harness.registry,
        buildList([
          buildStdioStatus("alpha", OFF),
          buildStdioStatus("beta", buildConnectedState(1))
        ])
      )
      expect(
        harness.registry
          .listToolDefinitions()
          .map((definition) => definition.name)
      ).toEqual(["mcp__beta__echo"])
      expect(harness.registry.findTurnTool("mcp__alpha__echo")).toEqual({
        status: "not-connected"
      })
      expect(harness.registry.openServerAgain("alpha")).toBe("off")
      expect(harness.openServer).toHaveBeenCalledTimes(1)
    })

    it("stops a connected server's session when it is switched off, reporting it, and opens it again once it is switched on", async () => {
      const harness = createRegistryHarness()
      const alpha = buildFakeStdioServerSettings("alpha")
      harness.setServers([alpha])
      await harness.registry.updateServers()
      await waitForServerList(
        harness.registry,
        buildList([buildStdioStatus("alpha", buildConnectedState(1))])
      )
      harness.setServers([buildSwitchedOffSettings(alpha)])

      await harness.registry.updateServers()

      expect(harness.registry.listServers()).toEqual(
        buildList([buildStdioStatus("alpha", OFF)])
      )
      expect(
        findOpenedConnection(harness.openedConnections, "alpha").close
      ).toHaveBeenCalledTimes(1)
      expect(filterEvents(harness.events, "server-stopped")).toEqual([
        { kind: "server-stopped", serverName: "alpha", reason: "switched-off" }
      ])
      harness.setServers([alpha])
      await harness.registry.updateServers()
      expect(harness.registry.listServers()).toEqual(
        buildList([buildStdioStatus("alpha", CONNECTING)])
      )
      await waitForServerList(
        harness.registry,
        buildList([buildStdioStatus("alpha", buildConnectedState(1))])
      )
      expect(harness.openServer).toHaveBeenCalledTimes(2)
    })

    it("reports a stopped session as removed when the settings no longer name its server, and as changed when they change it", async () => {
      const harness = createRegistryHarness()
      harness.setServers([
        buildFakeStdioServerSettings("alpha"),
        buildFakeStdioServerSettings("beta")
      ])
      await harness.registry.updateServers()
      await waitForServerList(
        harness.registry,
        buildList([
          buildStdioStatus("alpha", buildConnectedState(1)),
          buildStdioStatus("beta", buildConnectedState(1))
        ])
      )
      harness.setServers([
        buildFakeStdioServerSettings("beta", { tools: [ECHO_TOOL, FAIL_TOOL] })
      ])

      await harness.registry.updateServers()

      expect(filterEvents(harness.events, "server-stopped")).toEqual([
        { kind: "server-stopped", serverName: "alpha", reason: "removed" },
        { kind: "server-stopped", serverName: "beta", reason: "changed" }
      ])
      await waitForServerList(
        harness.registry,
        buildList([buildStdioStatus("beta", buildConnectedState(2))])
      )
    })

    it("lists a built-in server first, off, without reading what it needs, while it is switched off", async () => {
      const builtIn = createFakeBuiltInServer()
      const harness = createRegistryHarness({
        builtInServers: [builtIn.server]
      })
      harness.setServers([buildFakeStdioServerSettings("alpha")])

      await harness.registry.updateServers()

      expect(harness.registry.listServers()).toEqual(
        buildList([
          buildEmailStatus(OFF),
          buildStdioStatus("alpha", CONNECTING)
        ])
      )
      expect(builtIn.readServer).not.toHaveBeenCalled()
      expect(harness.registry.findTurnTool("mcp__email__echo")).toEqual({
        status: "not-connected"
      })
      expect(harness.registry.openServerAgain("email")).toBe("off")
      await waitForServerList(
        harness.registry,
        buildList([
          buildEmailStatus(OFF),
          buildStdioStatus("alpha", buildConnectedState(1))
        ])
      )
      expect(
        harness.openServer.mock.calls.map(([settings]) => settings.name)
      ).toEqual(["alpha"])
    })

    it("opens a switched-on built-in server with the settings its read builds, and keeps its session while a later read builds equal settings", async () => {
      const builtIn = createFakeBuiltInServer()
      const harness = createRegistryHarness({
        builtInServers: [builtIn.server]
      })
      harness.setServers([], EMAIL_ON)

      await harness.registry.updateServers()

      expect(harness.registry.listServers()).toEqual(
        buildList([buildEmailStatus(CONNECTING)])
      )
      expect(
        harness.openServer.mock.calls.map(([settings]) => settings)
      ).toEqual([buildFakeStdioServerSettings("email")])
      await waitForServerList(
        harness.registry,
        buildList([buildEmailStatus(buildConnectedState(1))])
      )
      expect(
        harness.registry
          .listToolDefinitions()
          .map((definition) => definition.name)
      ).toEqual(["mcp__email__echo"])
      await harness.registry.updateServers()
      expect(builtIn.readServer).toHaveBeenCalledTimes(2)
      expect(harness.openServer).toHaveBeenCalledTimes(1)
      expect(harness.registry.listServers()).toEqual(
        buildList([buildEmailStatus(buildConnectedState(1))])
      )
      expect(filterEvents(harness.events, "server-stopped")).toEqual([])
    })

    it("stops a built-in server's session as changed when its read builds other settings, and opens them", async () => {
      const builtIn = createFakeBuiltInServer()
      const harness = createRegistryHarness({
        builtInServers: [builtIn.server]
      })
      harness.setServers([], EMAIL_ON)
      await harness.registry.updateServers()
      await waitForServerList(
        harness.registry,
        buildList([buildEmailStatus(buildConnectedState(1))])
      )
      builtIn.setRead(
        buildBuiltInRead(
          buildFakeStdioServerSettings("email", {
            tools: [ECHO_TOOL, FAIL_TOOL]
          })
        )
      )

      await harness.registry.updateServers()

      expect(filterEvents(harness.events, "server-stopped")).toEqual([
        { kind: "server-stopped", serverName: "email", reason: "changed" }
      ])
      await waitForServerList(
        harness.registry,
        buildList([buildEmailStatus(buildConnectedState(2))])
      )
      expect(harness.openServer).toHaveBeenCalledTimes(2)
    })

    it("lists a switched-on built-in server as failed while its read finds no usable account, reporting each new reason once, and stops its session", async () => {
      const builtIn = createFakeBuiltInServer({ status: "account-missing" })
      const harness = createRegistryHarness({
        builtInServers: [builtIn.server]
      })
      harness.setServers([], EMAIL_ON)

      await harness.registry.updateServers()
      await harness.registry.updateServers()

      expect(harness.registry.listServers()).toEqual(
        buildList([buildEmailStatus(buildFailedState("account-missing"))])
      )
      expect(harness.openServer).not.toHaveBeenCalled()
      expect(harness.registry.openServerAgain("email")).toBe("off")
      expect(harness.registry.findTurnTool("mcp__email__echo")).toEqual({
        status: "not-connected"
      })
      expect(filterEvents(harness.events, "built-in-unusable")).toEqual([
        {
          kind: "built-in-unusable",
          serverName: "email",
          reason: "account-missing"
        }
      ])
      builtIn.setRead(buildBuiltInRead(buildFakeStdioServerSettings("email")))
      await harness.registry.updateServers()
      await waitForServerList(
        harness.registry,
        buildList([buildEmailStatus(buildConnectedState(1))])
      )
      builtIn.setRead({ status: "account-invalid" })
      await harness.registry.updateServers()
      expect(harness.registry.listServers()).toEqual(
        buildList([buildEmailStatus(buildFailedState("account-invalid"))])
      )
      expect(filterEvents(harness.events, "server-stopped")).toEqual([
        { kind: "server-stopped", serverName: "email", reason: "changed" }
      ])
      expect(filterEvents(harness.events, "built-in-unusable")).toEqual([
        {
          kind: "built-in-unusable",
          serverName: "email",
          reason: "account-missing"
        },
        {
          kind: "built-in-unusable",
          serverName: "email",
          reason: "account-invalid"
        }
      ])
    })

    it("rejects the apply whose read of what a switched-on built-in server needs throws, applying nothing, and applies the next read", async () => {
      const failure = new Error("Closing the settings file failed.")
      const builtIn = createFakeBuiltInServer()
      builtIn.readServer.mockRejectedValueOnce(failure)
      const harness = createRegistryHarness({
        builtInServers: [builtIn.server]
      })
      harness.setServers([buildFakeStdioServerSettings("alpha")], EMAIL_ON)

      await expect(harness.registry.updateServers()).rejects.toBe(failure)

      expect(harness.registry.listServers()).toEqual(buildList([]))
      expect(harness.openServer).not.toHaveBeenCalled()
      await harness.registry.updateServers()
      await waitForServerList(
        harness.registry,
        buildList([
          buildEmailStatus(buildConnectedState(1)),
          buildStdioStatus("alpha", buildConnectedState(1))
        ])
      )
    })

    it("applies an added server that has a built-in server's name in its place, reporting the taken name once, until the added one is removed", async () => {
      const builtIn = createFakeBuiltInServer()
      const harness = createRegistryHarness({
        builtInServers: [builtIn.server]
      })
      harness.setServers(
        [
          buildFakeStdioServerSettings("email", {
            tools: [ECHO_TOOL, FAIL_TOOL]
          })
        ],
        EMAIL_ON
      )

      await harness.registry.updateServers()
      await harness.registry.updateServers()

      expect(harness.registry.listServers()).toEqual(
        buildList([buildStdioStatus("email", CONNECTING)])
      )
      expect(builtIn.readServer).not.toHaveBeenCalled()
      expect(filterEvents(harness.events, "built-in-name-taken")).toEqual([
        { kind: "built-in-name-taken", serverName: "email" }
      ])
      await waitForServerList(
        harness.registry,
        buildList([buildStdioStatus("email", buildConnectedState(2))])
      )
      harness.setServers([], EMAIL_ON)
      await harness.registry.updateServers()
      expect(filterEvents(harness.events, "server-stopped")).toEqual([
        { kind: "server-stopped", serverName: "email", reason: "removed" }
      ])
      await waitForServerList(
        harness.registry,
        buildList([buildEmailStatus(buildConnectedState(1))])
      )
      expect(harness.openServer).toHaveBeenCalledTimes(2)
    })

    it("reports the taken name at the apply in which an added server takes the place of a built-in server listed before it", async () => {
      const builtIn = createFakeBuiltInServer()
      const harness = createRegistryHarness({
        builtInServers: [builtIn.server]
      })
      harness.setServers([])
      await harness.registry.updateServers()
      expect(harness.registry.listServers()).toEqual(
        buildList([buildEmailStatus(OFF)])
      )
      harness.setServers([buildFakeStdioServerSettings("email")])

      await harness.registry.updateServers()

      expect(harness.registry.listServers()).toEqual(
        buildList([buildStdioStatus("email", CONNECTING)])
      )
      expect(filterEvents(harness.events, "built-in-name-taken")).toEqual([
        { kind: "built-in-name-taken", serverName: "email" }
      ])
      await waitForServerList(
        harness.registry,
        buildList([buildStdioStatus("email", buildConnectedState(1))])
      )
    })

    it("stops a running built-in server as removed when an added server takes its name with equal settings, and lists the added server", async () => {
      const builtIn = createFakeBuiltInServer()
      const harness = createRegistryHarness({
        builtInServers: [builtIn.server]
      })
      harness.setServers([], EMAIL_ON)
      await harness.registry.updateServers()
      await waitForServerList(
        harness.registry,
        buildList([buildEmailStatus(buildConnectedState(1))])
      )
      harness.setServers([buildFakeStdioServerSettings("email")], EMAIL_ON)

      await harness.registry.updateServers()

      expect(harness.registry.listServers()).toEqual(
        buildList([buildStdioStatus("email", CONNECTING)])
      )
      expect(filterEvents(harness.events, "server-stopped")).toEqual([
        { kind: "server-stopped", serverName: "email", reason: "removed" }
      ])
      expect(filterEvents(harness.events, "built-in-name-taken")).toEqual([
        { kind: "built-in-name-taken", serverName: "email" }
      ])
      await waitForServerList(
        harness.registry,
        buildList([buildStdioStatus("email", buildConnectedState(1))])
      )
      expect(harness.openServer).toHaveBeenCalledTimes(2)
    })

    it("stops a running added server as removed when the built-in server of its name returns with equal settings, and lists the built-in server", async () => {
      const builtIn = createFakeBuiltInServer()
      const harness = createRegistryHarness({
        builtInServers: [builtIn.server]
      })
      harness.setServers([buildFakeStdioServerSettings("email")], EMAIL_ON)
      await harness.registry.updateServers()
      await waitForServerList(
        harness.registry,
        buildList([buildStdioStatus("email", buildConnectedState(1))])
      )
      harness.setServers([], EMAIL_ON)

      await harness.registry.updateServers()

      expect(harness.registry.listServers()).toEqual(
        buildList([buildEmailStatus(CONNECTING)])
      )
      expect(filterEvents(harness.events, "server-stopped")).toEqual([
        { kind: "server-stopped", serverName: "email", reason: "removed" }
      ])
      await waitForServerList(
        harness.registry,
        buildList([buildEmailStatus(buildConnectedState(1))])
      )
      expect(harness.openServer).toHaveBeenCalledTimes(2)
    })

    it("tells the model the server was stopped when its session is stopped while a call runs, and reports the failed call", async () => {
      const harness = createRegistryHarness()
      const alpha = buildFakeStdioServerSettings("alpha", {
        tools: [ECHO_TOOL, SLOW_TOOL]
      })
      harness.setServers([alpha])
      await harness.registry.updateServers()
      await waitForServerList(
        harness.registry,
        buildList([buildStdioStatus("alpha", buildConnectedState(2))])
      )
      const call = findTool(harness.registry, "mcp__alpha__slow").sendToolCall(
        {},
        NEVER_ABORTED
      )
      await waitForMicrotasks()
      harness.setServers([buildSwitchedOffSettings(alpha)])
      await harness.registry.updateServers()

      const outcome = await call

      expect(outcome).toEqual({
        status: "failed",
        content:
          "The call of mcp__alpha__slow failed: the MCP server alpha was stopped while the call ran: it was switched off, changed, or removed in Settings → MCP."
      })
      expect(filterEvents(harness.events, "tool-call-failed")).toEqual([
        {
          kind: "tool-call-failed",
          serverName: "alpha",
          serverToolName: "slow",
          failure: { kind: "closed" },
          unknownError: undefined
        }
      ])
    })

    it("ends an HTTP server's session when it is switched off while a call runs, tells the model the server was stopped, and lists it as off without tools", async () => {
      const server = await startFakeMcpHttpServer(
        answerToolCallsWith(() => {
          // The call is never answered, so only the switch-off ends it.
        })
      )
      const harness = createRegistryHarness()
      const remote = buildHttpServerSettings("remote", server.url)
      harness.setServers([remote])
      await harness.registry.updateServers()
      await waitForServerList(
        harness.registry,
        buildList([buildHttpStatus("remote", buildConnectedState(1))])
      )
      const call = findTool(harness.registry, "mcp__remote__echo").sendToolCall(
        { text: "x" },
        NEVER_ABORTED
      )
      await vi.waitFor(() => {
        expect(
          server.receivedRequests.map((request) => request.rpcMethod)
        ).toContain("tools/call")
      }, STATE_WAIT)
      harness.setServers([buildSwitchedOffSettings(remote)])

      await harness.registry.updateServers()
      const outcome = await call
      await waitForRegistryClose(
        findOpenedConnection(harness.openedConnections, "remote")
      )

      expect(outcome).toEqual({
        status: "failed",
        content:
          "The call of mcp__remote__echo failed: the MCP server remote was stopped while the call ran: it was switched off, changed, or removed in Settings → MCP."
      })
      expect(
        server.receivedRequests.filter((request) => request.method === "DELETE")
      ).toEqual([
        expect.objectContaining({
          headers: expect.objectContaining({ "mcp-session-id": "test-session" })
        })
      ])
      expect(harness.registry.listServers()).toEqual(
        buildList([buildHttpStatus("remote", OFF)])
      )
      expect(harness.registry.listToolDefinitions()).toEqual([])
      expect(harness.registry.findTurnTool("mcp__remote__echo")).toEqual({
        status: "not-connected"
      })
      expect(filterEvents(harness.events, "server-stopped")).toEqual([
        { kind: "server-stopped", serverName: "remote", reason: "switched-off" }
      ])
      expect(filterEvents(harness.events, "session-end-failed")).toEqual([])
    })
  })

  describe("close", () => {
    it("closes every connection, cancels every opening, and forgets every server", async () => {
      const harness = createRegistryHarness()
      harness.setServers([buildFakeStdioServerSettings("alpha")])
      await harness.registry.updateServers()
      await waitForServerList(
        harness.registry,
        buildList([buildStdioStatus("alpha", buildConnectedState(1))])
      )
      harness.holdOpenings()
      harness.setServers([
        buildFakeStdioServerSettings("alpha"),
        buildFakeStdioServerSettings("beta")
      ])
      await harness.registry.updateServers()

      await harness.registry.close()

      expect(harness.registry.listServers()).toEqual(buildList([]))
      expect(harness.registry.listToolDefinitions()).toEqual([])
      expect(harness.registry.findTurnTool("mcp__alpha__echo")).toEqual({
        status: "unknown"
      })
      const alpha = findOpenedConnection(harness.openedConnections, "alpha")
      expect(alpha.close).toHaveBeenCalledOnce()
      await expect(
        alpha.connection.sendToolCall("echo", { text: "x" }, NEVER_ABORTED)
      ).rejects.toThrow()
      expect(harness.openServer.mock.calls[1]?.[1].abortSignal.aborted).toBe(
        true
      )
      expect(harness.openedConnections).toHaveLength(1)
    })

    it("waits for an opening that ignores its cancellation, then for the close of the connection it ends with", async () => {
      const finish = Promise.withResolvers<void>()
      const closeEnd = Promise.withResolvers<void>()
      const harness = createRegistryHarness({
        open: async (settings, context, testEnded) => {
          const opening = await openFakeServer(settings, {
            ...context,
            abortSignal: NEVER_ABORTED
          })
          if (opening.status === "connected")
            holdCloseUntil(
              opening.connection,
              Promise.race([closeEnd.promise, testEnded])
            )
          await Promise.race([finish.promise, testEnded])
          return opening
        }
      })
      harness.setServers([buildFakeStdioServerSettings("alpha")])
      await harness.registry.updateServers()

      const closing = harness.registry.close()
      const closed = createSettlementReader(closing)
      await waitForMicrotasks()
      const settlementBeforeOpeningEnded = closed()
      finish.resolve()
      await vi.waitFor(() =>
        expect(
          findOpenedConnection(harness.openedConnections, "alpha").close
        ).toHaveBeenCalledOnce()
      )
      await waitForMicrotasks()
      const settlementBeforeCloseEnded = closed()
      closeEnd.resolve()
      await closing

      expect(settlementBeforeOpeningEnded).toBe("pending")
      expect(settlementBeforeCloseEnded).toBe("pending")
      expect(harness.openServer.mock.calls[0]?.[1].abortSignal.aborted).toBe(
        true
      )
      const alpha = findOpenedConnection(harness.openedConnections, "alpha")
      expect(alpha.close).toHaveBeenCalledOnce()
      await expect(
        alpha.connection.sendToolCall("echo", { text: "x" }, NEVER_ABORTED)
      ).rejects.toThrow()
      expect(harness.registry.listServers()).toEqual(buildList([]))
    })

    it("waits for a settings read in flight and applies nothing it returns", async () => {
      const read = Promise.withResolvers<McpSettingsRead>()
      const harness = createRegistryHarness({
        readSettings: (testEnded) =>
          Promise.race([
            read.promise,
            testEnded.then(() => buildSettingsRead([]))
          ])
      })
      const applying = harness.registry.updateServers()
      await waitForMicrotasks()

      const closing = harness.registry.close()
      const closed = createSettlementReader(closing)
      await waitForMicrotasks()
      const settlementBeforeRead = closed()
      read.resolve(buildSettingsRead([buildFakeStdioServerSettings("alpha")]))
      await closing

      expect(settlementBeforeRead).toBe("pending")
      await expect(applying).resolves.toBeUndefined()
      expect(harness.registry.listServers()).toEqual(buildList([]))
      expect(harness.openServer).not.toHaveBeenCalled()
    })

    it("does nothing once closed, and closing again settles too", async () => {
      const harness = createRegistryHarness()
      harness.setServers([buildFakeStdioServerSettings("alpha")])

      await harness.registry.close()
      await harness.registry.updateServers()

      expect(harness.readSettings).not.toHaveBeenCalled()
      expect(harness.registry.openServerAgain("alpha")).toBe("not-found")
      expect(harness.registry.listServers()).toEqual(buildList([]))
      expect(harness.openServer).not.toHaveBeenCalled()
      await expect(harness.registry.close()).resolves.toBeUndefined()
    })

    it("tells the model Lys was shutting down when closing stops a session while a call runs", async () => {
      const harness = createRegistryHarness()
      harness.setServers([
        buildFakeStdioServerSettings("alpha", { tools: [ECHO_TOOL, SLOW_TOOL] })
      ])
      await harness.registry.updateServers()
      await waitForServerList(
        harness.registry,
        buildList([buildStdioStatus("alpha", buildConnectedState(2))])
      )
      const call = findTool(harness.registry, "mcp__alpha__slow").sendToolCall(
        {},
        NEVER_ABORTED
      )
      await waitForMicrotasks()

      await harness.registry.close()
      const outcome = await call

      expect(outcome).toEqual({
        status: "failed",
        content:
          "The call of mcp__alpha__slow failed: the MCP server alpha was stopped while the call ran, because Lys was shutting down."
      })
      expect(filterEvents(harness.events, "tool-call-failed")).toEqual([
        {
          kind: "tool-call-failed",
          serverName: "alpha",
          serverToolName: "slow",
          failure: { kind: "closed" },
          unknownError: undefined
        }
      ])
    })
  })
})
