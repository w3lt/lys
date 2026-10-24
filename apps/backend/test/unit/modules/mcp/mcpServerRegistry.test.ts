import {
  MAXIMUM_MCP_SERVER_TOOL_COUNT,
  type McpServerFailure,
  type McpServerList,
  type McpServerState,
  type SkippedMcpTool
} from "@lys/protocol"
import { mcpSettingsSchema, type McpServerSettings } from "@lys/share"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
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
  type TurnMcpTool
} from "../../../../src/modules/mcp/mcpServerRegistry"
import {
  answerAsMcpServer,
  answerToolCallsWith,
  answerWithStatus,
  buildFakeStdioServerSettings,
  buildHttpServerSettings,
  ECHO_TOOL,
  startFakeMcpHttpServer,
  type McpHttpRoute
} from "../../support/mcpTestServers"
import { waitForMicrotasks } from "../../support/microtasks"
import { createSettlementReader } from "../../support/settlement"

/** Longest one test opening may take; far above a local fake server's start. */
const OPENING_TIMEOUT_MILLISECONDS = 10_000

/** Bound of every wait for the servers to reach a state. */
const STATE_WAIT = Object.freeze({ timeout: 10_000, interval: 10 })

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
   */
  setServers: (servers: readonly McpServerSettings[]) => void
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
 * @returns A `read` outcome.
 */
function buildSettingsRead(
  servers: readonly McpServerSettings[]
): McpSettingsRead {
  return Object.freeze({
    status: "read",
    settings: mcpSettingsSchema.parse(JSON.parse(JSON.stringify({ servers })))
  })
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
 * Creates a registry whose settings reads return what the case sets and
 * whose openings start real fake servers, closed when the case finishes.
 *
 * @param options - Opener and settings reader replacing the defaults.
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
  const open = options.open ?? openFakeServer
  let nextRead: () => McpSettingsRead = () => buildSettingsRead([])
  let hold: Promise<void> | undefined
  const readSettings = vi.fn(() =>
    options.readSettings === undefined
      ? Promise.resolve(nextRead())
      : options.readSettings(testEnd.promise)
  )
  const openServer = vi.fn(
    async (
      settings: McpServerSettings,
      context: McpServerConnectionContext
    ): Promise<McpServerOpening> => {
      const heldUntil = hold
      if (heldUntil !== undefined) {
        await Promise.race([
          heldUntil,
          waitForAbort(context.abortSignal),
          testEnd.promise
        ])
        if (context.abortSignal.aborted) return CANCELLED_OPENING
      }
      const opening = await open(settings, context, testEnd.promise)
      if (opening.status === "connected")
        openedConnections.push(
          Object.freeze({
            serverName: settings.name,
            connection: opening.connection,
            close: vi.spyOn(opening.connection, "close")
          })
        )
      return opening
    }
  )
  const registry = new McpServerRegistry({
    readSettings,
    openServer,
    workingDirectory: WORKING_DIRECTORY,
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
    setServers: (servers) => {
      nextRead = () => buildSettingsRead(servers)
    },
    setSettingsRead: (read) => {
      nextRead = () => read
    },
    holdOpenings: () => {
      const release = Promise.withResolvers<void>()
      hold = release.promise
      return () => {
        hold = undefined
        release.resolve()
      }
    }
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
  return { name, transport: "stdio", state }
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
  return { name, transport: "http", state }
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
 */
async function waitForServerList(
  registry: McpServerRegistry,
  expected: McpServerList
): Promise<void> {
  await vi.waitFor(() => {
    expect(registry.listServers()).toEqual(expected)
  }, STATE_WAIT)
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

      await harness.registry.applySettings()

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

      await harness.registry.applySettings()

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
      await harness.registry.applySettings()
      const settledList = buildList([
        buildStdioStatus("alpha", buildConnectedState(1)),
        buildStdioStatus("beta", buildFailedState("closed"))
      ])
      await waitForServerList(harness.registry, settledList)

      await harness.registry.applySettings()

      expect(harness.registry.listServers()).toEqual(settledList)
      expect(harness.readSettings).toHaveBeenCalledTimes(2)
      expect(harness.openServer).toHaveBeenCalledTimes(2)
      expect(
        findOpenedConnection(harness.openedConnections, "alpha").close
      ).not.toHaveBeenCalled()
      await expect(
        findTool(harness.registry, "mcp__alpha__echo").callTool(
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
      await harness.registry.applySettings()
      await waitForServerList(
        harness.registry,
        buildList([buildStdioStatus("alpha", buildConnectedState(1))])
      )
      const changedSettings = buildFakeStdioServerSettings("alpha", {}, [
        { name: "LYS_TEST_MODE", value: "changed" }
      ])
      harness.setServers([changedSettings])

      await harness.registry.applySettings()

      expect(harness.registry.listServers()).toEqual(
        buildList([buildStdioStatus("alpha", CONNECTING)])
      )
      const first = findOpenedConnection(harness.openedConnections, "alpha")
      await waitForRegistryClose(first)
      await expect(
        first.connection.callTool("echo", { text: "x" }, NEVER_ABORTED)
      ).rejects.toThrow()
      await waitForServerList(
        harness.registry,
        buildList([buildStdioStatus("alpha", buildConnectedState(1))])
      )
      expect(harness.openServer).toHaveBeenCalledTimes(2)
      expect(harness.openServer.mock.calls[1]?.[0]).toEqual(changedSettings)
      expect(filterEvents(harness.events, "connection-closed")).toEqual([])
    })

    it("closes a server the settings no longer name", async () => {
      const harness = createRegistryHarness()
      harness.setServers([
        buildFakeStdioServerSettings("alpha"),
        buildFakeStdioServerSettings("beta")
      ])
      await harness.registry.applySettings()
      await waitForServerList(
        harness.registry,
        buildList([
          buildStdioStatus("alpha", buildConnectedState(1)),
          buildStdioStatus("beta", buildConnectedState(1))
        ])
      )
      harness.setServers([buildFakeStdioServerSettings("beta")])

      await harness.registry.applySettings()

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
      await harness.registry.applySettings()
      const connected = [buildStdioStatus("alpha", buildConnectedState(1))]
      await waitForServerList(harness.registry, buildList(connected))
      const problems = ["servers.0.command: A command is 1 to 4096 characters."]

      harness.setSettingsRead({ status: "invalid", problems })
      await harness.registry.applySettings()
      const afterInvalid = harness.registry.listServers()
      harness.setSettingsRead({ status: "unreadable" })
      await harness.registry.applySettings()
      const afterUnreadable = harness.registry.listServers()
      harness.setServers([buildFakeStdioServerSettings("alpha")])
      await harness.registry.applySettings()

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

      const first = harness.registry.applySettings()
      const second = harness.registry.applySettings()
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

      const failing = harness.registry.applySettings()
      const next = harness.registry.applySettings()

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

      await harness.registry.applySettings()

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
      await harness.registry.applySettings()
      await waitForServerList(
        harness.registry,
        buildList([buildStdioStatus("alpha", buildConnectedState(2))])
      )

      const outcome = await findTool(
        harness.registry,
        "mcp__alpha__exit"
      ).callTool({}, NEVER_ABORTED)

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
      await harness.registry.applySettings()
      await waitForServerList(
        harness.registry,
        buildList([buildHttpStatus("remote", buildConnectedState(1))])
      )

      const outcome = await findTool(
        harness.registry,
        "mcp__remote__echo"
      ).callTool({}, NEVER_ABORTED)

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
          const exitCall = opening.connection.callTool(
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

      await harness.registry.applySettings()

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
      await harness.registry.applySettings()

      expect(harness.registry.reconnect("ghost")).toBe("not-found")
      expect(harness.registry.reconnect("alpha-2")).toBe("not-found")
      expect(harness.openServer).toHaveBeenCalledOnce()
      expect(harness.openServer.mock.calls[0]?.[1].abortSignal.aborted).toBe(
        false
      )
    })

    it("closes a connected server and opens it again with its applied settings", async () => {
      const harness = createRegistryHarness()
      const settings = buildFakeStdioServerSettings("alpha")
      harness.setServers([settings])
      await harness.registry.applySettings()
      await waitForServerList(
        harness.registry,
        buildList([buildStdioStatus("alpha", buildConnectedState(1))])
      )

      expect(harness.registry.reconnect("alpha")).toBe("reconnecting")

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

    it("opens a failed server again, which connects once the server answers", async () => {
      let route: McpHttpRoute = answerWithStatus(401)
      const server = await startFakeMcpHttpServer((request, body, response) => {
        route(request, body, response)
      })
      const harness = createRegistryHarness()
      harness.setServers([buildHttpServerSettings("remote", server.url)])
      await harness.registry.applySettings()
      await waitForServerList(
        harness.registry,
        buildList([buildHttpStatus("remote", buildFailedState("unauthorized"))])
      )
      route = answerAsMcpServer()

      expect(harness.registry.reconnect("remote")).toBe("reconnecting")

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

    it("cancels an opening it supersedes, and closes the connection that opening still ends with", async () => {
      const lateRelease = Promise.withResolvers<void>()
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
          return opening
        }
      })
      harness.setServers([buildFakeStdioServerSettings("alpha")])
      await harness.registry.applySettings()

      expect(harness.registry.reconnect("alpha")).toBe("reconnecting")

      expect(harness.openServer.mock.calls[0]?.[1].abortSignal.aborted).toBe(
        true
      )
      await waitForServerList(
        harness.registry,
        buildList([buildStdioStatus("alpha", buildConnectedState(1))])
      )
      lateRelease.resolve()
      await vi.waitFor(() => {
        expect(harness.openedConnections).toHaveLength(2)
      }, STATE_WAIT)
      await waitForRegistryClose(
        findOpenedConnection(harness.openedConnections, "alpha", 1)
      )
      expect(
        findOpenedConnection(harness.openedConnections, "alpha", 0).close
      ).not.toHaveBeenCalled()
      expect(harness.registry.listServers()).toEqual(
        buildList([buildStdioStatus("alpha", buildConnectedState(1))])
      )
      expect(filterEvents(harness.events, "connected")).toHaveLength(1)
      await expect(
        findTool(harness.registry, "mcp__alpha__echo").callTool(
          { text: "current" },
          NEVER_ABORTED
        )
      ).resolves.toMatchObject({ status: "succeeded" })
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
      await harness.registry.applySettings()
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
      await harness.registry.applySettings()
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
      await harness.registry.applySettings()
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
          callTool: expect.any(Function)
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
      await harness.registry.applySettings()
      await waitForServerList(
        harness.registry,
        buildList([buildStdioStatus("alpha", buildConnectedState(2))])
      )

      const echoed = await findTool(
        harness.registry,
        "mcp__alpha__echo"
      ).callTool({ text: "hi" }, NEVER_ABORTED)
      const failed = await findTool(
        harness.registry,
        "mcp__alpha__fail"
      ).callTool({}, NEVER_ABORTED)

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

    it("tells the model the server is not connected when it is not connected at call time", async () => {
      const harness = createRegistryHarness()
      harness.setServers([buildFakeStdioServerSettings("alpha")])
      await harness.registry.applySettings()
      await waitForServerList(
        harness.registry,
        buildList([buildStdioStatus("alpha", buildConnectedState(1))])
      )
      const tool = findTool(harness.registry, "mcp__alpha__echo")
      harness.holdOpenings()
      harness.registry.reconnect("alpha")

      const outcome = await tool.callTool({ text: "hi" }, NEVER_ABORTED)

      expect(outcome).toEqual({
        status: "failed",
        content:
          "The call of mcp__alpha__echo failed: the MCP server alpha is not connected now. The person can reconnect it in Settings → MCP."
      })
    })

    it("tells the model the server no longer lists the tool it was offered", async () => {
      const harness = createRegistryHarness()
      harness.setServers([
        buildFakeStdioServerSettings("alpha", {
          tools: [ECHO_TOOL, FAIL_TOOL, LOOK_DOT_UP_TOOL]
        })
      ])
      await harness.registry.applySettings()
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
      await harness.registry.applySettings()
      await waitForServerList(
        harness.registry,
        buildList([buildStdioStatus("alpha", buildConnectedState(2))])
      )

      const removedOutcome = await removedTool.callTool({}, NEVER_ABORTED)
      const renamedOutcome = await renamedTool.callTool({}, NEVER_ABORTED)

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
    })

    it("reports a call that failed before a result, and tells the model why", async () => {
      const harness = createRegistryHarness()
      harness.setServers([
        buildFakeStdioServerSettings("alpha", {
          tools: [ECHO_TOOL, REFUSE_TOOL]
        })
      ])
      await harness.registry.applySettings()
      await waitForServerList(
        harness.registry,
        buildList([buildStdioStatus("alpha", buildConnectedState(2))])
      )

      const outcome = await findTool(
        harness.registry,
        "mcp__alpha__refuse"
      ).callTool({}, NEVER_ABORTED)

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
      await harness.registry.applySettings()
      await waitForServerList(
        harness.registry,
        buildList([buildStdioStatus("alpha", buildConnectedState(2))])
      )
      const controller = new AbortController()
      const call = findTool(harness.registry, "mcp__alpha__slow").callTool(
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

  describe("close", () => {
    it("closes every connection, cancels every opening, and forgets every server", async () => {
      const harness = createRegistryHarness()
      harness.setServers([buildFakeStdioServerSettings("alpha")])
      await harness.registry.applySettings()
      await waitForServerList(
        harness.registry,
        buildList([buildStdioStatus("alpha", buildConnectedState(1))])
      )
      harness.holdOpenings()
      harness.setServers([
        buildFakeStdioServerSettings("alpha"),
        buildFakeStdioServerSettings("beta")
      ])
      await harness.registry.applySettings()

      await harness.registry.close()

      expect(harness.registry.listServers()).toEqual(buildList([]))
      expect(harness.registry.listToolDefinitions()).toEqual([])
      expect(harness.registry.findTurnTool("mcp__alpha__echo")).toEqual({
        status: "unknown"
      })
      const alpha = findOpenedConnection(harness.openedConnections, "alpha")
      expect(alpha.close).toHaveBeenCalledOnce()
      await expect(
        alpha.connection.callTool("echo", { text: "x" }, NEVER_ABORTED)
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
      await harness.registry.applySettings()

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
        alpha.connection.callTool("echo", { text: "x" }, NEVER_ABORTED)
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
      const applying = harness.registry.applySettings()
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
      await harness.registry.applySettings()

      expect(harness.readSettings).not.toHaveBeenCalled()
      expect(harness.registry.reconnect("alpha")).toBe("not-found")
      expect(harness.registry.listServers()).toEqual(buildList([]))
      expect(harness.openServer).not.toHaveBeenCalled()
      await expect(harness.registry.close()).resolves.toBeUndefined()
    })
  })
})
