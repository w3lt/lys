import type { McpServerList } from "@lys/protocol"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import type { BackendServerInfo } from "@/lib/store"
import {
  buildJsonResponse,
  createTransportFailure,
  FIXTURE_BACKEND_URL,
  startBackendFake,
  type BackendRoute,
  type BackendRoutes
} from "../../support/backendFake"
import {
  buildBuiltInMcpServerStatus,
  buildConnectedMcpState,
  buildFailedMcpState,
  buildMcpServerList,
  buildMcpServerListRoute,
  buildMcpServerNotFoundProblem,
  buildMcpServerOffProblem,
  buildMcpServerStatus,
  CONNECTING_MCP_STATE,
  OFF_MCP_STATE
} from "../../support/mcpFixtures"
import { startNativeHostFake } from "../../support/nativeHostFake"
import {
  createControlledPromise,
  createSettlementReader,
  waitForMicrotasks
} from "../../support/settlement"
import {
  STORED_MCP_SETTINGS,
  STORED_SETTINGS,
  STORED_SETTINGS_DOCUMENT
} from "../../support/settingsFixtures"

/** Route key of the list read. */
const LIST_ROUTE = "GET /api/v1/mcp/servers"

/** Route key of the sync. */
const SYNC_ROUTE = "POST /api/v1/mcp/servers/sync"

/** Route key of a reconnect of the `notes` server. */
const RECONNECT_NOTES_ROUTE = "POST /api/v1/mcp/servers/notes/reconnect"

/** Route key of the backend's tool list. */
const TOOL_LIST_ROUTE = "GET /api/v1/tools"

/** Backend whose health route answered. */
const RUNNING_BACKEND: BackendServerInfo = Object.freeze({ status: "running" })

/** Backend that does not run. */
const STOPPED_BACKEND: BackendServerInfo = Object.freeze({ status: "stopped" })

/** Both stored servers connected, with three and one tools. */
const CONNECTED_LIST = buildMcpServerList([
  buildMcpServerStatus("files", "stdio", buildConnectedMcpState(3)),
  buildMcpServerStatus("notes", "http", buildConnectedMcpState(1))
])

/** The stored command server connected, the URL server still connecting. */
const CONNECTING_LIST = buildMcpServerList([
  buildMcpServerStatus("files", "stdio", buildConnectedMcpState(3)),
  buildMcpServerStatus("notes", "http", CONNECTING_MCP_STATE)
])

/** Failure shown before a case's action, with a text no action gives. */
const EARLIER_FAILURE = Object.freeze({
  action: "sync",
  error: "Earlier failure."
} as const)

/** Failure of a sync whose request did not reach the backend. */
const SYNC_FAILURE = Object.freeze({
  action: "sync",
  error:
    "Lys's request to apply the MCP servers failed: The backend could not be reached."
} as const)

/** The stored command server connected with one more tool than before. */
const MORE_TOOLS_LIST = buildMcpServerList([
  buildMcpServerStatus("files", "stdio", buildConnectedMcpState(4)),
  buildMcpServerStatus("notes", "http", buildConnectedMcpState(1))
])

/** Answer of the backend's tool list: no backend tool. */
const EMPTY_BACKEND_TOOL_LIST = Object.freeze({
  tools: [],
  unavailableTools: []
})

/** The stored URL server refused, kept after an invalid settings group. */
const INVALID_SETTINGS_LIST = buildMcpServerList(
  [buildMcpServerStatus("notes", "http", buildFailedMcpState("unauthorized"))],
  "invalid"
)

/**
 * Declared problems the backend refuses a reconnect of `notes` with, each
 * changing nothing: the server is not applied, or it is switched off or
 * cannot start.
 */
const RECONNECT_REFUSALS = [
  [
    "has not applied the server",
    () => buildJsonResponse(404, buildMcpServerNotFoundProblem("notes"))
  ],
  [
    "says the server is switched off or cannot start",
    () => buildJsonResponse(409, buildMcpServerOffProblem("notes"))
  ]
] as const

/**
 * Builds a route that answers with a server list.
 *
 * @param list - List the backend answers with.
 * @returns The route.
 */
function answerList(list: McpServerList): BackendRoute {
  return () => buildJsonResponse(200, list)
}

/**
 * Builds the loaded list state the store holds for a list.
 *
 * @param list - List the backend answered with.
 * @returns The expected state.
 */
function buildLoadedState(list: McpServerList) {
  return { status: "loaded", settings: list.settings, servers: list.servers }
}

/**
 * Loads fresh stores from one module graph: the MCP server store, the
 * application store it reads, and the tool store it refreshes.
 *
 * @param backendServerInfo - Backend status to publish; running by default.
 * @returns The store hooks and the refresh registration.
 */
async function loadFreshMcpServerStore(
  backendServerInfo: BackendServerInfo = RUNNING_BACKEND
) {
  vi.resetModules()
  const { useMcpServerStore, registerMcpServerRefresh } =
    await import("@/lib/store/mcp-servers")
  const { useLysStore } = await import("@/lib/store")
  const { useToolStore } = await import("@/lib/store/tools")
  useLysStore.setState({
    backendUrl: FIXTURE_BACKEND_URL,
    backendServerInfo,
    settings: STORED_SETTINGS
  })
  return {
    useMcpServerStore,
    useLysStore,
    useToolStore,
    registerMcpServerRefresh
  }
}

/**
 * Starts a backend that answers the given routes, recording the routes of
 * the requests in arrival order.
 *
 * @param routes - Routes the case expects.
 * @returns The backend handle and a reader of the requested route keys.
 */
function startMcpBackend(routes: BackendRoutes) {
  const backend = startBackendFake(routes)
  return {
    backend,
    readRouteKeys: () => backend.requests.map((request) => request.routeKey)
  }
}

/**
 * Starts a native host holding the stored settings document, whose writes
 * succeed or fail as the case says.
 *
 * @param saveSettings - Answer of every write; succeeds by default.
 * @returns The host observation handle.
 */
function startSettingsHost(saveSettings: () => unknown = () => null) {
  return startNativeHostFake({
    load_settings: () => STORED_SETTINGS_DOCUMENT,
    save_settings: saveSettings
  })
}

describe("useMcpServerStore", () => {
  describe("loadMcpServers", () => {
    it("starts with no list and no failure", async () => {
      const { useMcpServerStore } = await loadFreshMcpServerStore()

      expect(useMcpServerStore.getState().list).toEqual({ status: "idle" })
      expect(useMcpServerStore.getState().actionFailure).toBeNull()
    })

    it("shows loading during the first read, then the backend's list from the current origin", async () => {
      const answer = createControlledPromise<Response>()
      const { backend } = startMcpBackend({
        [LIST_ROUTE]: () => answer.promise
      })
      const { useMcpServerStore } = await loadFreshMcpServerStore()

      const read = useMcpServerStore.getState().loadMcpServers()
      const whileReading = useMcpServerStore.getState().list
      answer.resolve(buildJsonResponse(200, INVALID_SETTINGS_LIST))
      await read

      expect(whileReading).toEqual({ status: "loading" })
      expect(useMcpServerStore.getState().list).toEqual(
        buildLoadedState(INVALID_SETTINGS_LIST)
      )
      expect(backend.requests[0]?.url).toBe(
        `${FIXTURE_BACKEND_URL}/api/v1/mcp/servers`
      )
    })

    it("joins a read in flight instead of sending another", async () => {
      const answer = createControlledPromise<Response>()
      const { backend } = startMcpBackend({
        [LIST_ROUTE]: () => answer.promise
      })
      const { useMcpServerStore } = await loadFreshMcpServerStore()

      const first = useMcpServerStore.getState().loadMcpServers()
      const second = useMcpServerStore.getState().loadMcpServers()
      answer.resolve(buildJsonResponse(200, CONNECTED_LIST))
      await Promise.all([first, second])

      expect(second).toBe(first)
      expect(backend.requests).toHaveLength(1)
    })

    it("keeps a loaded list shown while it is read again", async () => {
      const second = createControlledPromise<Response>()
      let reads = 0
      startMcpBackend({
        [LIST_ROUTE]: () => {
          reads += 1
          return reads === 1
            ? buildJsonResponse(200, CONNECTING_LIST)
            : second.promise
        }
      })
      const { useMcpServerStore } = await loadFreshMcpServerStore()
      await useMcpServerStore.getState().loadMcpServers()

      const reread = useMcpServerStore.getState().loadMcpServers()
      const whileReading = useMcpServerStore.getState().list
      second.resolve(buildJsonResponse(200, CONNECTED_LIST))
      await reread

      expect(whileReading).toEqual(buildLoadedState(CONNECTING_LIST))
      expect(useMcpServerStore.getState().list).toEqual(
        buildLoadedState(CONNECTED_LIST)
      )
    })

    it("shows why a read failed", async () => {
      startMcpBackend({
        [LIST_ROUTE]: () => Promise.reject(createTransportFailure())
      })
      const { useMcpServerStore } = await loadFreshMcpServerStore()

      await useMcpServerStore.getState().loadMcpServers()

      expect(useMcpServerStore.getState().list).toEqual({
        status: "failed",
        error:
          "Lys couldn't read the state of the MCP servers: The backend could not be reached."
      })
    })

    it("reads again after a failed read", async () => {
      startMcpBackend({
        [LIST_ROUTE]: buildMcpServerListRoute([CONNECTED_LIST])
      })
      const { useMcpServerStore } = await loadFreshMcpServerStore()
      useMcpServerStore.setState({
        list: { status: "failed", error: "Earlier failure." }
      })

      const read = useMcpServerStore.getState().loadMcpServers()
      const whileReading = useMcpServerStore.getState().list
      await read

      expect(whileReading).toEqual({ status: "loading" })
      expect(useMcpServerStore.getState().list).toEqual(
        buildLoadedState(CONNECTED_LIST)
      )
    })
  })

  describe("sendMcpServerSync", () => {
    it("shows the list the backend applied and clears an earlier failure", async () => {
      const { backend } = startMcpBackend({
        [SYNC_ROUTE]: answerList(CONNECTING_LIST)
      })
      const { useMcpServerStore } = await loadFreshMcpServerStore()
      useMcpServerStore.setState({ actionFailure: EARLIER_FAILURE })

      await useMcpServerStore.getState().sendMcpServerSync()

      expect(useMcpServerStore.getState().list).toEqual(
        buildLoadedState(CONNECTING_LIST)
      )
      expect(useMcpServerStore.getState().actionFailure).toBeNull()
      expect(backend.requests[0]?.body).toEqual({})
    })

    it("keeps the list and says the backend could not be reached when the sync's request fails", async () => {
      startMcpBackend({
        [LIST_ROUTE]: answerList(CONNECTED_LIST),
        [SYNC_ROUTE]: () => Promise.reject(createTransportFailure())
      })
      const { useMcpServerStore } = await loadFreshMcpServerStore()
      await useMcpServerStore.getState().loadMcpServers()

      await useMcpServerStore.getState().sendMcpServerSync()

      expect(useMcpServerStore.getState().list).toEqual(
        buildLoadedState(CONNECTED_LIST)
      )
      expect(useMcpServerStore.getState().actionFailure).toEqual(SYNC_FAILURE)
    })

    it("clears a shown failure once a sync starts, so the same failure shows again", async () => {
      const secondAnswer = createControlledPromise<Response>()
      let syncs = 0
      startMcpBackend({
        [SYNC_ROUTE]: () => {
          syncs += 1
          return syncs === 1
            ? Promise.reject(createTransportFailure())
            : secondAnswer.promise
        }
      })
      const { useMcpServerStore } = await loadFreshMcpServerStore()
      await useMcpServerStore.getState().sendMcpServerSync()
      const afterFirst = useMcpServerStore.getState().actionFailure

      const second = useMcpServerStore.getState().sendMcpServerSync()
      const whileSyncing = useMcpServerStore.getState().actionFailure
      secondAnswer.reject(createTransportFailure())
      await second

      expect(afterFirst).toEqual(SYNC_FAILURE)
      expect(whileSyncing).toBeNull()
      expect(useMcpServerStore.getState().actionFailure).toEqual(SYNC_FAILURE)
    })

    it.each([
      [
        "an error status",
        () => new Response(null, { status: 500 }),
        "The backend could not complete the MCP server request (HTTP 500)."
      ],
      [
        "a list that does not match the shared schema",
        () => buildJsonResponse(200, { settings: "applied" }),
        "The backend returned an invalid MCP server list."
      ]
    ])(
      "keeps the list and says what the backend answered when it answers the sync with %s",
      async (_label, route, reason) => {
        startMcpBackend({
          [LIST_ROUTE]: answerList(CONNECTED_LIST),
          [SYNC_ROUTE]: route
        })
        const { useMcpServerStore } = await loadFreshMcpServerStore()
        await useMcpServerStore.getState().loadMcpServers()

        await useMcpServerStore.getState().sendMcpServerSync()

        expect(useMcpServerStore.getState().list).toEqual(
          buildLoadedState(CONNECTED_LIST)
        )
        expect(useMcpServerStore.getState().actionFailure).toEqual({
          action: "sync",
          error: `Lys's request to apply the MCP servers failed: ${reason}`
        })
      }
    )

    it("reads the list once a sync settled instead of joining it", async () => {
      const { readRouteKeys } = startMcpBackend({
        [LIST_ROUTE]: answerList(CONNECTED_LIST),
        [SYNC_ROUTE]: answerList(CONNECTING_LIST)
      })
      const { useMcpServerStore } = await loadFreshMcpServerStore()
      await useMcpServerStore.getState().sendMcpServerSync()

      await useMcpServerStore.getState().loadMcpServers()

      expect(readRouteKeys()).toEqual([SYNC_ROUTE, LIST_ROUTE])
      expect(useMcpServerStore.getState().list).toEqual(
        buildLoadedState(CONNECTED_LIST)
      )
    })
  })

  describe("sendMcpServerReconnect", () => {
    it("shows the list right after the server was opened again", async () => {
      startMcpBackend({
        [RECONNECT_NOTES_ROUTE]: answerList(CONNECTING_LIST)
      })
      const { useMcpServerStore } = await loadFreshMcpServerStore()
      useMcpServerStore.setState({ actionFailure: EARLIER_FAILURE })

      await useMcpServerStore.getState().sendMcpServerReconnect("notes")

      expect(useMcpServerStore.getState().list).toEqual(
        buildLoadedState(CONNECTING_LIST)
      )
      expect(useMcpServerStore.getState().actionFailure).toBeNull()
    })

    it("clears a shown failure once a reconnect starts", async () => {
      const answer = createControlledPromise<Response>()
      startMcpBackend({ [RECONNECT_NOTES_ROUTE]: () => answer.promise })
      const { useMcpServerStore } = await loadFreshMcpServerStore()
      useMcpServerStore.setState({ actionFailure: EARLIER_FAILURE })

      const reconnect = useMcpServerStore
        .getState()
        .sendMcpServerReconnect("notes")
      const whileReconnecting = useMcpServerStore.getState().actionFailure
      answer.resolve(buildJsonResponse(200, CONNECTING_LIST))
      await reconnect

      expect(whileReconnecting).toBeNull()
    })

    it.each([
      [
        "its request does not reach the backend",
        () => Promise.reject(createTransportFailure()),
        "The backend could not be reached."
      ],
      [
        "the backend answers with an error status",
        () => new Response(null, { status: 503 }),
        "The backend could not complete the MCP server request (HTTP 503)."
      ]
    ])(
      "names the server and says why when %s",
      async (_label, route, reason) => {
        startMcpBackend({ [RECONNECT_NOTES_ROUTE]: route })
        const { useMcpServerStore } = await loadFreshMcpServerStore()

        await useMcpServerStore.getState().sendMcpServerReconnect("notes")

        expect(useMcpServerStore.getState().list).toEqual({ status: "idle" })
        expect(useMcpServerStore.getState().actionFailure).toEqual({
          action: "reconnect",
          error: `Lys's request to reconnect notes failed: ${reason}`
        })
      }
    )

    it.each(RECONNECT_REFUSALS)(
      "applies the saved servers when the backend %s",
      async (_label, refusal) => {
        const { readRouteKeys } = startMcpBackend({
          [RECONNECT_NOTES_ROUTE]: refusal,
          [SYNC_ROUTE]: answerList(CONNECTING_LIST)
        })
        const { useMcpServerStore } = await loadFreshMcpServerStore()

        await useMcpServerStore.getState().sendMcpServerReconnect("notes")

        expect(readRouteKeys()).toEqual([RECONNECT_NOTES_ROUTE, SYNC_ROUTE])
        expect(useMcpServerStore.getState().list).toEqual(
          buildLoadedState(CONNECTING_LIST)
        )
        expect(useMcpServerStore.getState().actionFailure).toBeNull()
      }
    )
  })

  describe("answers out of order", () => {
    it("keeps a sync's list when a read started before it answers after it", async () => {
      const readAnswer = createControlledPromise<Response>()
      startMcpBackend({
        [LIST_ROUTE]: () => readAnswer.promise,
        [SYNC_ROUTE]: answerList(CONNECTING_LIST)
      })
      const { useMcpServerStore } = await loadFreshMcpServerStore()

      const read = useMcpServerStore.getState().loadMcpServers()
      await useMcpServerStore.getState().sendMcpServerSync()
      readAnswer.resolve(buildJsonResponse(200, CONNECTED_LIST))
      await read

      expect(useMcpServerStore.getState().list).toEqual(
        buildLoadedState(CONNECTING_LIST)
      )
    })

    it("does not show a sync's failure once a later reconnect answered", async () => {
      const syncAnswer = createControlledPromise<Response>()
      startMcpBackend({
        [SYNC_ROUTE]: () => syncAnswer.promise,
        [RECONNECT_NOTES_ROUTE]: answerList(CONNECTING_LIST)
      })
      const { useMcpServerStore } = await loadFreshMcpServerStore()

      const sync = useMcpServerStore.getState().sendMcpServerSync()
      await useMcpServerStore.getState().sendMcpServerReconnect("notes")
      syncAnswer.reject(createTransportFailure())
      await sync

      expect(useMcpServerStore.getState().actionFailure).toBeNull()
    })

    it("joins a sync in flight instead of reading, so the sync's list is shown", async () => {
      const syncAnswer = createControlledPromise<Response>()
      const { readRouteKeys } = startMcpBackend({
        [LIST_ROUTE]: answerList(CONNECTED_LIST),
        [SYNC_ROUTE]: () => syncAnswer.promise
      })
      const { useMcpServerStore } = await loadFreshMcpServerStore()
      const sync = useMcpServerStore.getState().sendMcpServerSync()

      const read = useMcpServerStore.getState().loadMcpServers()
      const readSettlement = createSettlementReader(read)
      await waitForMicrotasks()
      const settledBeforeTheSync = readSettlement()
      syncAnswer.resolve(buildJsonResponse(200, CONNECTING_LIST))
      await Promise.all([sync, read])

      expect(settledBeforeTheSync).toBe("pending")
      expect(readRouteKeys()).toEqual([SYNC_ROUTE])
      expect(useMcpServerStore.getState().list).toEqual(
        buildLoadedState(CONNECTING_LIST)
      )
    })

    it("joins a reconnect in flight and the sync it falls back to", async () => {
      const syncAnswer = createControlledPromise<Response>()
      const { readRouteKeys } = startMcpBackend({
        [LIST_ROUTE]: answerList(CONNECTED_LIST),
        [RECONNECT_NOTES_ROUTE]: () =>
          buildJsonResponse(404, buildMcpServerNotFoundProblem("notes")),
        [SYNC_ROUTE]: () => syncAnswer.promise
      })
      const { useMcpServerStore } = await loadFreshMcpServerStore()
      const reconnect = useMcpServerStore
        .getState()
        .sendMcpServerReconnect("notes")
      const duringReconnect = useMcpServerStore.getState().loadMcpServers()
      await vi.waitFor(() => {
        expect(readRouteKeys()).toEqual([RECONNECT_NOTES_ROUTE, SYNC_ROUTE])
      })

      const duringSync = useMcpServerStore.getState().loadMcpServers()
      syncAnswer.resolve(buildJsonResponse(200, CONNECTING_LIST))
      await Promise.all([reconnect, duringReconnect, duringSync])

      expect(readRouteKeys()).toEqual([RECONNECT_NOTES_ROUTE, SYNC_ROUTE])
      expect(useMcpServerStore.getState().list).toEqual(
        buildLoadedState(CONNECTING_LIST)
      )
    })
  })

  describe("resetMcpServers", () => {
    it("forgets the list and the failure, and discards an answer in flight", async () => {
      const readAnswer = createControlledPromise<Response>()
      startMcpBackend({ [LIST_ROUTE]: () => readAnswer.promise })
      const { useMcpServerStore } = await loadFreshMcpServerStore()
      useMcpServerStore.setState({ actionFailure: EARLIER_FAILURE })

      const read = useMcpServerStore.getState().loadMcpServers()
      useMcpServerStore.getState().resetMcpServers()
      readAnswer.resolve(buildJsonResponse(200, CONNECTED_LIST))
      await read

      expect(useMcpServerStore.getState().list).toEqual({ status: "idle" })
      expect(useMcpServerStore.getState().actionFailure).toBeNull()
    })

    it("reads after a reset instead of joining a sync it discarded", async () => {
      const syncAnswer = createControlledPromise<Response>()
      const { readRouteKeys } = startMcpBackend({
        [LIST_ROUTE]: answerList(CONNECTED_LIST),
        [SYNC_ROUTE]: () => syncAnswer.promise
      })
      const { useMcpServerStore } = await loadFreshMcpServerStore()
      const sync = useMcpServerStore.getState().sendMcpServerSync()
      useMcpServerStore.getState().resetMcpServers()

      await useMcpServerStore.getState().loadMcpServers()
      syncAnswer.resolve(buildJsonResponse(200, CONNECTING_LIST))
      await sync

      expect(readRouteKeys()).toEqual([SYNC_ROUTE, LIST_ROUTE])
      expect(useMcpServerStore.getState().list).toEqual(
        buildLoadedState(CONNECTED_LIST)
      )
    })

    it("lets a read start after the reset instead of joining the discarded one", async () => {
      const firstAnswer = createControlledPromise<Response>()
      let reads = 0
      const { backend } = startMcpBackend({
        [LIST_ROUTE]: () => {
          reads += 1
          return reads === 1
            ? firstAnswer.promise
            : buildJsonResponse(200, CONNECTED_LIST)
        }
      })
      const { useMcpServerStore } = await loadFreshMcpServerStore()

      const discarded = useMcpServerStore.getState().loadMcpServers()
      useMcpServerStore.getState().resetMcpServers()
      await useMcpServerStore.getState().loadMcpServers()
      firstAnswer.resolve(buildJsonResponse(200, CONNECTING_LIST))
      await discarded

      expect(backend.requests).toHaveLength(2)
      expect(useMcpServerStore.getState().list).toEqual(
        buildLoadedState(CONNECTED_LIST)
      )
    })

    it.each(RECONNECT_REFUSALS)(
      "discards the answer of a reconnect arriving after the reset, applying nothing, when the backend %s",
      async (_label, refusal) => {
        const reconnectAnswer = createControlledPromise<Response>()
        const { readRouteKeys } = startMcpBackend({
          [RECONNECT_NOTES_ROUTE]: () => reconnectAnswer.promise,
          [SYNC_ROUTE]: answerList(CONNECTED_LIST)
        })
        const { useMcpServerStore } = await loadFreshMcpServerStore()
        const reconnect = useMcpServerStore
          .getState()
          .sendMcpServerReconnect("notes")
        useMcpServerStore.getState().resetMcpServers()

        reconnectAnswer.resolve(refusal())
        await reconnect
        await waitForMicrotasks()

        expect(readRouteKeys()).toEqual([RECONNECT_NOTES_ROUTE])
        expect(useMcpServerStore.getState().list).toEqual({ status: "idle" })
        expect(useMcpServerStore.getState().actionFailure).toBeNull()
      }
    )
  })

  describe("saveMcpServers", () => {
    it("saves the servers, then asks the running backend to apply them", async () => {
      const host = startSettingsHost()
      const { readRouteKeys } = startMcpBackend({
        [SYNC_ROUTE]: answerList(CONNECTING_LIST)
      })
      const { useMcpServerStore, useLysStore } = await loadFreshMcpServerStore()
      const onlyFiles = [STORED_MCP_SETTINGS.servers[0]]

      await expect(
        useMcpServerStore.getState().saveMcpServers(onlyFiles)
      ).resolves.toBe("saved")
      await vi.waitFor(() => {
        expect(useMcpServerStore.getState().list.status).toBe("loaded")
      })

      expect(useLysStore.getState().settings.mcp).toEqual({
        ...STORED_MCP_SETTINGS,
        servers: onlyFiles
      })
      expect(
        host.commands.filter((invoked) => invoked.command === "save_settings")
      ).toHaveLength(1)
      expect(readRouteKeys()).toEqual([SYNC_ROUTE])
    })

    it("asks nothing of a backend that is not running, which applies the saved servers when it starts", async () => {
      startSettingsHost()
      const { backend } = startMcpBackend({})
      const { useMcpServerStore } =
        await loadFreshMcpServerStore(STOPPED_BACKEND)

      await expect(
        useMcpServerStore.getState().saveMcpServers([])
      ).resolves.toBe("saved")
      await waitForMicrotasks()

      expect(backend.requests).toEqual([])
    })

    it("asks nothing of the backend when the save failed", async () => {
      startSettingsHost(() => Promise.reject("Disk full"))
      const { backend } = startMcpBackend({})
      const { useMcpServerStore, useLysStore } = await loadFreshMcpServerStore()

      await expect(
        useMcpServerStore.getState().saveMcpServers([])
      ).resolves.toBe("failed")
      await waitForMicrotasks()

      expect(backend.requests).toEqual([])
      expect(useLysStore.getState().settings.mcp).toEqual(STORED_MCP_SETTINGS)
    })
  })

  describe("saveBuiltInMcpServerSwitch", () => {
    /** The stored servers with the email server switched on and starting. */
    const EMAIL_STARTING_LIST = buildMcpServerList([
      buildBuiltInMcpServerStatus("email", CONNECTING_MCP_STATE),
      ...CONNECTED_LIST.servers
    ])

    it("saves the switch, then asks the running backend to apply the group", async () => {
      const host = startSettingsHost()
      const { readRouteKeys } = startMcpBackend({
        [SYNC_ROUTE]: answerList(EMAIL_STARTING_LIST)
      })
      const { useMcpServerStore, useLysStore } = await loadFreshMcpServerStore()

      await expect(
        useMcpServerStore.getState().saveBuiltInMcpServerSwitch("email", true)
      ).resolves.toBe("saved")
      await vi.waitFor(() => {
        expect(useMcpServerStore.getState().list).toEqual(
          buildLoadedState(EMAIL_STARTING_LIST)
        )
      })

      expect(useLysStore.getState().settings.mcp).toEqual({
        ...STORED_MCP_SETTINGS,
        builtIn: { email: { enabled: true } }
      })
      expect(
        host.commands.filter((invoked) => invoked.command === "save_settings")
      ).toHaveLength(1)
      expect(readRouteKeys()).toEqual([SYNC_ROUTE])
    })

    it("asks nothing of a backend that is not running", async () => {
      startSettingsHost()
      const { backend } = startMcpBackend({})
      const { useMcpServerStore } =
        await loadFreshMcpServerStore(STOPPED_BACKEND)

      await expect(
        useMcpServerStore.getState().saveBuiltInMcpServerSwitch("email", true)
      ).resolves.toBe("saved")
      await waitForMicrotasks()

      expect(backend.requests).toEqual([])
    })

    it("asks nothing of the backend when the save failed", async () => {
      startSettingsHost(() => Promise.reject("Disk full"))
      const { backend } = startMcpBackend({})
      const { useMcpServerStore, useLysStore } = await loadFreshMcpServerStore()

      await expect(
        useMcpServerStore.getState().saveBuiltInMcpServerSwitch("email", true)
      ).resolves.toBe("failed")
      await waitForMicrotasks()

      expect(backend.requests).toEqual([])
      expect(useLysStore.getState().settings.mcp).toEqual(STORED_MCP_SETTINGS)
    })
  })
})

describe("registerMcpServerRefresh", () => {
  /**
   * Loads fresh stores with the backend in the given state and registers
   * the refresh until the case ends.
   *
   * @param backendServerInfo - Backend status to publish first.
   * @returns The stores and the unsubscribe the registration returned.
   */
  async function startRefresh(backendServerInfo: BackendServerInfo) {
    const stores = await loadFreshMcpServerStore(backendServerInfo)
    const unsubscribe = stores.registerMcpServerRefresh()
    onTestFinished(unsubscribe)
    return { ...stores, unsubscribe }
  }

  /**
   * Switches the case to fake timers until it ends.
   */
  function useFakeTimersForCase(): void {
    vi.useFakeTimers()
    onTestFinished(() => {
      vi.useRealTimers()
    })
  }

  it("asks the backend to apply the saved servers when it starts running, and forgets the list when it stops", async () => {
    const { readRouteKeys } = startMcpBackend({
      [SYNC_ROUTE]: answerList(CONNECTED_LIST)
    })
    const { useMcpServerStore, useLysStore } =
      await startRefresh(STOPPED_BACKEND)

    useLysStore.setState({ backendServerInfo: RUNNING_BACKEND })
    await vi.waitFor(() => {
      expect(useMcpServerStore.getState().list).toEqual(
        buildLoadedState(CONNECTED_LIST)
      )
    })
    useLysStore.setState({ backendServerInfo: STOPPED_BACKEND })

    expect(readRouteKeys()).toEqual([SYNC_ROUTE])
    expect(useMcpServerStore.getState().list).toEqual({ status: "idle" })
  })

  it("applies servers saved while the backend was starting once it runs", async () => {
    startSettingsHost()
    const { readRouteKeys } = startMcpBackend({
      [SYNC_ROUTE]: answerList(CONNECTING_LIST)
    })
    const { useMcpServerStore, useLysStore } = await startRefresh({
      status: "starting"
    })

    await expect(
      useMcpServerStore
        .getState()
        .saveMcpServers([STORED_MCP_SETTINGS.servers[0]])
    ).resolves.toBe("saved")
    await waitForMicrotasks()
    const routesWhileStarting = readRouteKeys()
    useLysStore.setState({ backendServerInfo: RUNNING_BACKEND })
    await vi.waitFor(() => {
      expect(useMcpServerStore.getState().list.status).toBe("loaded")
    })

    expect(routesWhileStarting).toEqual([])
    expect(readRouteKeys()).toEqual([SYNC_ROUTE])
  })

  it("reads the list at once when the backend already runs", async () => {
    startMcpBackend({ [LIST_ROUTE]: answerList(CONNECTED_LIST) })
    const { useMcpServerStore } = await startRefresh(RUNNING_BACKEND)

    await vi.waitFor(() => {
      expect(useMcpServerStore.getState().list).toEqual(
        buildLoadedState(CONNECTED_LIST)
      )
    })
  })

  it("reads nothing while the backend changes between states that are not running", async () => {
    const { backend } = startMcpBackend({})
    const { useLysStore } = await startRefresh(STOPPED_BACKEND)

    useLysStore.setState({ backendServerInfo: { status: "starting" } })
    useLysStore.setState({ backendServerInfo: { status: "unresponsive" } })
    await waitForMicrotasks()

    expect(backend.requests).toEqual([])
  })

  it.each([
    { state: "connected", settledList: CONNECTED_LIST },
    {
      state: "failed",
      settledList: buildMcpServerList([
        CONNECTED_LIST.servers[0],
        buildMcpServerStatus(
          "notes",
          "http",
          buildFailedMcpState("unreachable")
        )
      ])
    },
    {
      state: "off",
      settledList: buildMcpServerList([
        CONNECTED_LIST.servers[0],
        buildMcpServerStatus("notes", "http", OFF_MCP_STATE)
      ])
    }
  ] as const)(
    "reads the list again each second while a server connects, and stops once it is $state",
    async ({ settledList }) => {
      useFakeTimersForCase()
      const { backend } = startMcpBackend({
        [LIST_ROUTE]: buildMcpServerListRoute([
          CONNECTING_LIST,
          CONNECTING_LIST,
          settledList
        ])
      })
      const { useMcpServerStore } = await startRefresh(RUNNING_BACKEND)
      await waitForMicrotasks()
      const readsAtFirst = backend.requests.length

      await vi.advanceTimersByTimeAsync(999)
      const readsBeforeASecond = backend.requests.length
      await vi.advanceTimersByTimeAsync(1)
      const readsAfterASecond = backend.requests.length
      await vi.advanceTimersByTimeAsync(1000)
      const readsAfterTwoSeconds = backend.requests.length
      await vi.advanceTimersByTimeAsync(5000)

      expect([
        readsAtFirst,
        readsBeforeASecond,
        readsAfterASecond,
        readsAfterTwoSeconds
      ]).toEqual([1, 1, 2, 3])
      expect(backend.requests).toHaveLength(3)
      expect(useMcpServerStore.getState().list).toEqual(
        buildLoadedState(settledList)
      )
    }
  )

  it("lets a read due while a sync runs join it, so the sync's list is shown", async () => {
    useFakeTimersForCase()
    const syncAnswer = createControlledPromise<Response>()
    const { readRouteKeys } = startMcpBackend({
      [LIST_ROUTE]: answerList(CONNECTING_LIST),
      [SYNC_ROUTE]: () => syncAnswer.promise
    })
    const { useMcpServerStore } = await startRefresh(RUNNING_BACKEND)
    await waitForMicrotasks()

    const sync = useMcpServerStore.getState().sendMcpServerSync()
    await vi.advanceTimersByTimeAsync(1000)
    syncAnswer.resolve(buildJsonResponse(200, CONNECTED_LIST))
    await sync
    await vi.advanceTimersByTimeAsync(5000)

    expect(readRouteKeys()).toEqual([LIST_ROUTE, SYNC_ROUTE])
    expect(useMcpServerStore.getState().list).toEqual(
      buildLoadedState(CONNECTED_LIST)
    )
  })

  it("cancels the next read of the list once an answer shows no server connecting", async () => {
    useFakeTimersForCase()
    const { readRouteKeys } = startMcpBackend({
      [LIST_ROUTE]: answerList(CONNECTING_LIST),
      [SYNC_ROUTE]: answerList(CONNECTED_LIST)
    })
    const { useMcpServerStore } = await startRefresh(RUNNING_BACKEND)
    await waitForMicrotasks()

    await vi.advanceTimersByTimeAsync(500)
    await useMcpServerStore.getState().sendMcpServerSync()
    await vi.advanceTimersByTimeAsync(5000)

    expect(readRouteKeys()).toEqual([LIST_ROUTE, SYNC_ROUTE])
    expect(useMcpServerStore.getState().list).toEqual(
      buildLoadedState(CONNECTED_LIST)
    )
  })

  it("schedules no read of the list after a read of it failed", async () => {
    useFakeTimersForCase()
    const { readRouteKeys } = startMcpBackend({
      [LIST_ROUTE]: () => Promise.reject(createTransportFailure())
    })
    const { useMcpServerStore } = await startRefresh(RUNNING_BACKEND)
    await waitForMicrotasks()
    const statusAfterRead = useMcpServerStore.getState().list.status

    await vi.advanceTimersByTimeAsync(5000)

    expect(statusAfterRead).toBe("failed")
    expect(readRouteKeys()).toEqual([LIST_ROUTE])
  })

  it("schedules no read of the list once the backend stopped and the list is forgotten", async () => {
    useFakeTimersForCase()
    const { readRouteKeys } = startMcpBackend({
      [LIST_ROUTE]: answerList(CONNECTED_LIST)
    })
    const { useMcpServerStore, useLysStore } =
      await startRefresh(RUNNING_BACKEND)
    await waitForMicrotasks()
    const listWhileRunning = useMcpServerStore.getState().list

    useLysStore.setState({ backendServerInfo: STOPPED_BACKEND })
    await vi.advanceTimersByTimeAsync(5000)

    expect(listWhileRunning).toEqual(buildLoadedState(CONNECTED_LIST))
    expect(readRouteKeys()).toEqual([LIST_ROUTE])
    expect(useMcpServerStore.getState().list).toEqual({ status: "idle" })
  })

  it("stops reading the list again once unsubscribed", async () => {
    useFakeTimersForCase()
    const { backend } = startMcpBackend({
      [LIST_ROUTE]: answerList(CONNECTING_LIST)
    })
    const { useLysStore, unsubscribe } = await startRefresh(RUNNING_BACKEND)
    await waitForMicrotasks()

    unsubscribe()
    await vi.advanceTimersByTimeAsync(5000)
    useLysStore.setState({ backendServerInfo: STOPPED_BACKEND })
    useLysStore.setState({ backendServerInfo: RUNNING_BACKEND })
    await waitForMicrotasks()

    expect(backend.requests).toHaveLength(1)
  })

  it("reads a tool list already read again when the connected servers' tools change", async () => {
    startNativeHostFake({ list_tools: () => [] })
    const { readRouteKeys } = startMcpBackend({
      [TOOL_LIST_ROUTE]: () =>
        buildJsonResponse(200, { tools: [], unavailableTools: [] }),
      [LIST_ROUTE]: answerList(CONNECTING_LIST),
      [SYNC_ROUTE]: answerList(CONNECTED_LIST)
    })
    const { useMcpServerStore, useToolStore } =
      await startRefresh(STOPPED_BACKEND)
    await useToolStore.getState().loadTools()

    await useMcpServerStore.getState().loadMcpServers()
    await vi.waitFor(() => {
      expect(useToolStore.getState().list.status).toBe("loaded")
    })
    // The same servers with the same tools leave the tool list alone.
    await useMcpServerStore.getState().loadMcpServers()
    await waitForMicrotasks()
    await useMcpServerStore.getState().sendMcpServerSync()
    await vi.waitFor(() => {
      expect(useToolStore.getState().list.status).toBe("loaded")
    })

    expect(readRouteKeys()).toEqual([
      TOOL_LIST_ROUTE,
      LIST_ROUTE,
      TOOL_LIST_ROUTE,
      LIST_ROUTE,
      SYNC_ROUTE,
      TOOL_LIST_ROUTE
    ])
  })

  it("reads a tool list already read again when a connected server's tool count changes", async () => {
    startNativeHostFake({ list_tools: () => [] })
    const { readRouteKeys } = startMcpBackend({
      [TOOL_LIST_ROUTE]: () => buildJsonResponse(200, EMPTY_BACKEND_TOOL_LIST),
      [LIST_ROUTE]: buildMcpServerListRoute([CONNECTED_LIST, MORE_TOOLS_LIST])
    })
    const { useMcpServerStore, useToolStore } =
      await startRefresh(STOPPED_BACKEND)
    await useToolStore.getState().loadTools()
    await useMcpServerStore.getState().loadMcpServers()
    await vi.waitFor(() => {
      expect(readRouteKeys()).toHaveLength(3)
    })
    const routeKeysAfterToolCountChange = [
      TOOL_LIST_ROUTE,
      LIST_ROUTE,
      TOOL_LIST_ROUTE,
      LIST_ROUTE,
      TOOL_LIST_ROUTE
    ]

    await useMcpServerStore.getState().loadMcpServers()
    await vi.waitFor(() => {
      expect(readRouteKeys()).toEqual(routeKeysAfterToolCountChange)
    })
  })

  it("leaves a tool list already read alone while a server moves among connecting, failed, and off", async () => {
    startNativeHostFake({ list_tools: () => [] })
    const { readRouteKeys } = startMcpBackend({
      [TOOL_LIST_ROUTE]: () => buildJsonResponse(200, EMPTY_BACKEND_TOOL_LIST),
      [LIST_ROUTE]: buildMcpServerListRoute([
        CONNECTING_LIST,
        buildMcpServerList([
          CONNECTED_LIST.servers[0],
          buildMcpServerStatus(
            "notes",
            "http",
            buildFailedMcpState("unreachable")
          )
        ]),
        buildMcpServerList([
          CONNECTED_LIST.servers[0],
          buildMcpServerStatus("notes", "http", OFF_MCP_STATE)
        ]),
        CONNECTING_LIST
      ])
    })
    const { useMcpServerStore, useToolStore } =
      await startRefresh(STOPPED_BACKEND)
    await useToolStore.getState().loadTools()
    await useMcpServerStore.getState().loadMcpServers()
    await vi.waitFor(() => {
      expect(readRouteKeys()).toHaveLength(3)
    })

    await useMcpServerStore.getState().loadMcpServers()
    await useMcpServerStore.getState().loadMcpServers()
    await useMcpServerStore.getState().loadMcpServers()
    await waitForMicrotasks()

    expect(readRouteKeys()).toEqual([
      TOOL_LIST_ROUTE,
      LIST_ROUTE,
      TOOL_LIST_ROUTE,
      LIST_ROUTE,
      LIST_ROUTE,
      LIST_ROUTE
    ])
    expect(useToolStore.getState().list.status).toBe("loaded")
  })

  it("reads the tool list again in a read that starts after a tool read in flight", async () => {
    startNativeHostFake({ list_tools: () => [] })
    const pendingToolRead = createControlledPromise<Response>()
    let toolReads = 0
    const { readRouteKeys } = startMcpBackend({
      [TOOL_LIST_ROUTE]: () => {
        toolReads += 1
        return toolReads === 2
          ? pendingToolRead.promise
          : buildJsonResponse(200, EMPTY_BACKEND_TOOL_LIST)
      },
      [LIST_ROUTE]: answerList(CONNECTED_LIST)
    })
    const { useMcpServerStore, useToolStore } =
      await startRefresh(STOPPED_BACKEND)
    await useToolStore.getState().loadTools()
    const readStartedBefore = useToolStore.getState().loadTools()

    await useMcpServerStore.getState().loadMcpServers()
    pendingToolRead.resolve(buildJsonResponse(200, EMPTY_BACKEND_TOOL_LIST))
    await readStartedBefore

    await vi.waitFor(() => {
      expect(readRouteKeys()).toEqual([
        TOOL_LIST_ROUTE,
        TOOL_LIST_ROUTE,
        LIST_ROUTE,
        TOOL_LIST_ROUTE
      ])
    })
  })

  it("reads a tool list already read again when the same servers connect after the backend restarted", async () => {
    startNativeHostFake({ list_tools: () => [] })
    const { readRouteKeys } = startMcpBackend({
      [TOOL_LIST_ROUTE]: () => buildJsonResponse(200, EMPTY_BACKEND_TOOL_LIST),
      [SYNC_ROUTE]: answerList(CONNECTED_LIST)
    })
    const { useLysStore, useToolStore } = await startRefresh(STOPPED_BACKEND)
    await useToolStore.getState().loadTools()
    useLysStore.setState({ backendServerInfo: RUNNING_BACKEND })
    await vi.waitFor(() => {
      expect(readRouteKeys()).toHaveLength(3)
    })

    useLysStore.setState({ backendServerInfo: STOPPED_BACKEND })
    useLysStore.setState({ backendServerInfo: RUNNING_BACKEND })

    await vi.waitFor(() => {
      expect(readRouteKeys()).toEqual([
        TOOL_LIST_ROUTE,
        SYNC_ROUTE,
        TOOL_LIST_ROUTE,
        SYNC_ROUTE,
        TOOL_LIST_ROUTE
      ])
    })
  })

  it("leaves a tool list never read alone, for whoever needs it first to read", async () => {
    const { readRouteKeys } = startMcpBackend({
      [LIST_ROUTE]: answerList(CONNECTED_LIST)
    })
    const { useMcpServerStore, useToolStore } =
      await startRefresh(STOPPED_BACKEND)

    await useMcpServerStore.getState().loadMcpServers()
    await waitForMicrotasks()

    expect(readRouteKeys()).toEqual([LIST_ROUTE])
    expect(useToolStore.getState().list.status).toBe("idle")
  })
})
