import type {
  BackendToolUnavailableReason,
  UnavailableBackendTool
} from "@lys/protocol"
import type { ToolDefinition } from "@lys/share"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import type { BackendServerStatus } from "@/lib/store"
import {
  buildChatToolOffer,
  getToolChoice,
  isToolOn,
  type ToolListState
} from "@/lib/store/tools"
import {
  buildJsonResponse,
  startBackendFake,
  type BackendRoute
} from "../../support/backendFake"
import { startNativeHostFake } from "../../support/nativeHostFake"
import {
  createControlledPromise,
  waitForMicrotasks
} from "../../support/settlement"
import {
  buildBackendToolDefinition,
  buildToolDefinition
} from "../../support/toolFixtures"

/** Tools the desktop lists, in Settings order. */
const CLIENT_TOOLS = [
  buildToolDefinition("read_text_file"),
  buildToolDefinition("find_files")
]

/** Tool the backend lists: it sends requests off this machine. */
const READ_PAGE = buildBackendToolDefinition("read_page")

/** Second tool the backend lists, which can lack what it needs to run. */
const WEB_SEARCH = buildBackendToolDefinition("web_search")

/** Availability of a list in which every tool can run now. */
const ALL_TOOLS_AVAILABLE: ReadonlyMap<string, BackendToolUnavailableReason> =
  new Map()

/** Route key of the backend's tool list. */
const BACKEND_TOOLS_ROUTE = "GET /api/v1/tools"

/**
 * Builds the backend's tool-list route.
 *
 * @param tools - Tools the backend lists.
 * @param unavailableTools - Listed tools that cannot run now, and why; none
 * by default.
 * @returns The route answering with them.
 */
function buildBackendToolsRoute(
  tools: readonly ToolDefinition[] = [READ_PAGE],
  unavailableTools: readonly UnavailableBackendTool[] = []
): BackendRoute {
  return () => buildJsonResponse(200, { tools, unavailableTools })
}

/**
 * Loads a fresh tool store, so no list or choice of another case reaches
 * this one.
 *
 * @returns The store hook of a newly evaluated store module.
 */
async function loadFreshToolStore() {
  vi.resetModules()
  const { useToolStore } = await import("@/lib/store/tools")
  return useToolStore
}

/**
 * Loads a fresh tool store with the application store it reads and the
 * registration of the tool-list refresh, all from one module graph.
 *
 * @returns Both store hooks and the registration.
 */
async function loadFreshToolStores() {
  vi.resetModules()
  const { useToolStore, registerToolListRefresh } =
    await import("@/lib/store/tools")
  const { useLysStore } = await import("@/lib/store")
  return { useToolStore, useLysStore, registerToolListRefresh }
}

/**
 * Starts a backend whose tool list says `read_page` cannot run until the
 * given read, and can from that read on.
 *
 * @param firstReadyRead - One-based read from which `read_page` can run.
 * @returns The backend observation handle.
 */
function startBackendOfferingReadPageFrom(firstReadyRead: number) {
  let reads = 0
  return startBackendFake({
    [BACKEND_TOOLS_ROUTE]: () => {
      reads += 1
      return buildJsonResponse(200, {
        tools: [READ_PAGE],
        unavailableTools:
          reads >= firstReadyRead
            ? []
            : [{ name: "read_page", reason: "page-reader-not-ready" }]
      })
    }
  })
}

describe("isToolOn", () => {
  it("returns the switch the person changed", () => {
    const findFiles = buildToolDefinition("find_files")

    expect(isToolOn(new Map([["find_files", false]]), findFiles)).toBe(false)
    expect(isToolOn(new Map([["read_page", true]]), READ_PAGE)).toBe(true)
  })

  it("returns on for an unchanged tool that only reads this machine and off for one that sends requests off it", () => {
    expect(isToolOn(new Map(), buildToolDefinition("find_files"))).toBe(true)
    expect(isToolOn(new Map(), READ_PAGE)).toBe(false)
  })
})

describe("getToolChoice", () => {
  it("combines the session switch with the saved approval", () => {
    const findFiles = buildToolDefinition("find_files")
    const toolChoices = {
      switches: new Map([["find_files", false]]),
      justRunToolNames: new Set(["find_files"])
    }

    expect(getToolChoice(toolChoices, findFiles)).toEqual({
      isOn: false,
      approval: "run"
    })
  })

  it("asks first for a tool whose name is not saved as Just run, network tools included", () => {
    const toolChoices = {
      switches: new Map([["read_page", true]]),
      justRunToolNames: new Set(["find_files"])
    }

    expect(getToolChoice(toolChoices, READ_PAGE)).toEqual({
      isOn: true,
      approval: "ask"
    })
    expect(
      getToolChoice(toolChoices, buildToolDefinition("read_text_file"))
    ).toEqual({ isOn: true, approval: "ask" })
  })
})

/** Tool list states before a read has committed a list. */
const UNREAD_TOOL_LISTS: readonly ToolListState[] = Object.freeze([
  Object.freeze({ status: "idle" }),
  Object.freeze({ status: "loading" })
])

describe("buildChatToolOffer", () => {
  it("offers every desktop tool the person has not switched off, in list order", () => {
    const readTextFile = buildToolDefinition("read_text_file")
    const findFiles = buildToolDefinition("find_files")
    const searchFiles = buildToolDefinition("search_files")

    expect(
      buildChatToolOffer({
        list: {
          status: "loaded",
          tools: [readTextFile, findFiles, searchFiles, READ_PAGE],
          unavailableTools: ALL_TOOLS_AVAILABLE
        },
        toolSwitches: new Map([["read_text_file", false]])
      })
    ).toEqual({
      status: "offered",
      offer: { definitions: [findFiles, searchFiles] }
    })
  })

  it("offers a switched-on backend tool by name beside the desktop tools' definitions", () => {
    const findFiles = buildToolDefinition("find_files")

    expect(
      buildChatToolOffer({
        list: {
          status: "loaded",
          tools: [findFiles, READ_PAGE],
          unavailableTools: ALL_TOOLS_AVAILABLE
        },
        toolSwitches: new Map([["read_page", true]])
      })
    ).toEqual({
      status: "offered",
      offer: { definitions: [findFiles], backendToolNames: ["read_page"] }
    })
  })

  it("leaves out a switched-on backend tool that cannot run now", () => {
    expect(
      buildChatToolOffer({
        list: {
          status: "loaded",
          tools: [READ_PAGE, WEB_SEARCH],
          unavailableTools: new Map([["web_search", "api-key-missing"]])
        },
        toolSwitches: new Map([
          ["read_page", true],
          ["web_search", true]
        ])
      })
    ).toEqual({
      status: "offered",
      offer: { definitions: [], backendToolNames: ["read_page"] }
    })
  })

  it("offers no tools when the only switched-on tool cannot run now", () => {
    expect(
      buildChatToolOffer({
        list: {
          status: "loaded",
          tools: [WEB_SEARCH],
          unavailableTools: new Map([["web_search", "settings-unreadable"]])
        },
        toolSwitches: new Map([["web_search", true]])
      })
    ).toEqual({ status: "not-offered" })
  })

  it.each([
    ["every listed tool is switched off", [...CLIENT_TOOLS, READ_PAGE]],
    ["only an unchanged backend tool is listed", [READ_PAGE]],
    ["no tool is listed", []]
  ])("offers no tools when %s", (_label, tools) => {
    expect(
      buildChatToolOffer({
        list: {
          status: "loaded",
          tools,
          unavailableTools: ALL_TOOLS_AVAILABLE
        },
        toolSwitches: new Map([
          ["read_text_file", false],
          ["find_files", false]
        ])
      })
    ).toEqual({ status: "not-offered" })
  })

  it("reports the failed read's reason and how to chat without tools", () => {
    const reason = "Lys couldn't read its tool list: bad name."

    expect(
      buildChatToolOffer({
        list: { status: "failed", error: reason },
        toolSwitches: new Map()
      })
    ).toEqual({
      status: "unavailable",
      error: expect.stringMatching(
        /^Lys couldn't read its tool list: bad name\. .*Turn tool calls off in Settings → Tools/
      )
    })
  })

  it.each(UNREAD_TOOL_LISTS)(
    "reports the tool list unavailable while it is $status",
    (list) => {
      expect(buildChatToolOffer({ list, toolSwitches: new Map() })).toEqual({
        status: "unavailable",
        error: expect.stringMatching(
          /^Lys couldn't read its tool list\. .*Turn tool calls off in Settings → Tools/
        )
      })
    }
  )
})

describe("useToolStore", () => {
  it("starts with no list, tool calls on, and no changed switch", async () => {
    const useToolStore = await loadFreshToolStore()

    expect(useToolStore.getState()).toMatchObject({
      list: { status: "idle" },
      areToolCallsOn: true,
      toolSwitches: new Map()
    })
  })

  describe("loadTools", () => {
    it("shows loading while either list is read, then the desktop's tools followed by the backend's", async () => {
      const clientList = createControlledPromise<unknown>()
      startNativeHostFake({ list_tools: () => clientList.promise })
      const backend = startBackendFake({
        [BACKEND_TOOLS_ROUTE]: buildBackendToolsRoute()
      })
      const useToolStore = await loadFreshToolStore()

      const load = useToolStore.getState().loadTools()
      await waitForMicrotasks()
      const whileReading = useToolStore.getState().list
      clientList.resolve(CLIENT_TOOLS)
      await load

      expect(whileReading).toEqual({ status: "loading" })
      expect(useToolStore.getState().list).toEqual({
        status: "loaded",
        tools: [...CLIENT_TOOLS, READ_PAGE],
        unavailableTools: new Map()
      })
      expect(backend.requests.map((request) => request.url)).toEqual([
        "http://127.0.0.1:12345/api/v1/tools"
      ])
    })

    it("keeps why each backend tool that cannot run now cannot, by name", async () => {
      startNativeHostFake({ list_tools: () => CLIENT_TOOLS })
      startBackendFake({
        [BACKEND_TOOLS_ROUTE]: buildBackendToolsRoute(
          [READ_PAGE, WEB_SEARCH],
          [{ name: "web_search", reason: "api-key-invalid" }]
        )
      })
      const useToolStore = await loadFreshToolStore()

      await useToolStore.getState().loadTools()

      expect(useToolStore.getState().list).toEqual({
        status: "loaded",
        tools: [...CLIENT_TOOLS, READ_PAGE, WEB_SEARCH],
        unavailableTools: new Map([["web_search", "api-key-invalid"]])
      })
    })

    it("joins a read already in flight", async () => {
      const clientList = createControlledPromise<unknown>()
      const host = startNativeHostFake({ list_tools: () => clientList.promise })
      const backend = startBackendFake({
        [BACKEND_TOOLS_ROUTE]: buildBackendToolsRoute()
      })
      const useToolStore = await loadFreshToolStore()

      const first = useToolStore.getState().loadTools()
      const second = useToolStore.getState().loadTools()
      clientList.resolve(CLIENT_TOOLS)
      await Promise.all([first, second])

      expect(host.commands).toHaveLength(1)
      expect(backend.requests).toHaveLength(1)
    })

    it("starts a new read once the previous one settled", async () => {
      const host = startNativeHostFake({ list_tools: () => CLIENT_TOOLS })
      const backend = startBackendFake({
        [BACKEND_TOOLS_ROUTE]: buildBackendToolsRoute()
      })
      const useToolStore = await loadFreshToolStore()
      await useToolStore.getState().loadTools()

      await useToolStore.getState().loadTools()

      expect(host.commands).toHaveLength(2)
      expect(backend.requests).toHaveLength(2)
    })

    it("shows a general failure when the desktop rejects with something other than an error", async () => {
      startNativeHostFake({
        list_tools: () => Promise.reject("command list_tools not found")
      })
      startBackendFake({ [BACKEND_TOOLS_ROUTE]: buildBackendToolsRoute() })
      const useToolStore = await loadFreshToolStore()

      await expect(useToolStore.getState().loadTools()).resolves.toBeUndefined()

      expect(useToolStore.getState().list).toEqual({
        status: "failed",
        error: "Lys couldn't read its tool list."
      })
    })

    it("names the reason in one presentable line when the desktop's list is invalid", async () => {
      startNativeHostFake({ list_tools: () => [{ name: "bad name!" }] })
      startBackendFake({ [BACKEND_TOOLS_ROUTE]: buildBackendToolsRoute() })
      const useToolStore = await loadFreshToolStore()

      await useToolStore.getState().loadTools()

      expect(useToolStore.getState().list).toEqual({
        status: "failed",
        error:
          "Lys couldn't read its tool list: The app returned an invalid tool list."
      })
    })

    it("fails the whole list when the backend's list cannot be read", async () => {
      startNativeHostFake({ list_tools: () => CLIENT_TOOLS })
      startBackendFake({
        [BACKEND_TOOLS_ROUTE]: () => new Response(null, { status: 500 })
      })
      const useToolStore = await loadFreshToolStore()

      await useToolStore.getState().loadTools()

      expect(useToolStore.getState().list).toEqual({
        status: "failed",
        error:
          "Lys couldn't read its tool list: The backend returned an invalid tool list."
      })
    })

    it("fails the list when the desktop and the backend name a tool alike", async () => {
      startNativeHostFake({ list_tools: () => CLIENT_TOOLS })
      startBackendFake({
        [BACKEND_TOOLS_ROUTE]: buildBackendToolsRoute([
          buildBackendToolDefinition("find_files")
        ])
      })
      const useToolStore = await loadFreshToolStore()

      await useToolStore.getState().loadTools()

      expect(useToolStore.getState().list).toEqual({
        status: "failed",
        error:
          "Lys couldn't read its tool list: the app and the backend both have a tool named find_files."
      })
    })
  })

  it("switches tool calls off", async () => {
    const useToolStore = await loadFreshToolStore()

    useToolStore.getState().updateToolCallsOn(false)

    expect(useToolStore.getState().areToolCallsOn).toBe(false)
  })

  it("switches one tool off, and a backend tool on", async () => {
    const useToolStore = await loadFreshToolStore()
    const findFiles = buildToolDefinition("find_files")

    useToolStore.getState().updateToolOn(findFiles, false)
    useToolStore.getState().updateToolOn(READ_PAGE, true)

    const { toolSwitches } = useToolStore.getState()
    expect(isToolOn(toolSwitches, findFiles)).toBe(false)
    expect(isToolOn(toolSwitches, READ_PAGE)).toBe(true)
  })

  it("leaves other tools and earlier switch snapshots unchanged", async () => {
    const useToolStore = await loadFreshToolStore()
    const before = useToolStore.getState().toolSwitches

    useToolStore
      .getState()
      .updateToolOn(buildToolDefinition("find_files"), false)
    await waitForMicrotasks()

    expect(
      isToolOn(
        useToolStore.getState().toolSwitches,
        buildToolDefinition("read_text_file")
      )
    ).toBe(true)
    expect(before.size).toBe(0)
  })

  describe("loadToolsAgain", () => {
    it("reads both lists again after a read in flight settles, so the list reflects the state after the call", async () => {
      const firstClientList = createControlledPromise<unknown>()
      let clientReads = 0
      const host = startNativeHostFake({
        list_tools: () => {
          clientReads += 1
          return clientReads === 1 ? firstClientList.promise : []
        }
      })
      const backend = startBackendOfferingReadPageFrom(2)
      const useToolStore = await loadFreshToolStore()

      const first = useToolStore.getState().loadTools()
      const again = useToolStore.getState().loadToolsAgain()
      firstClientList.resolve([])
      await Promise.all([first, again])

      expect(host.commands).toHaveLength(2)
      expect(backend.requests).toHaveLength(2)
      expect(useToolStore.getState().list).toEqual({
        status: "loaded",
        tools: [READ_PAGE],
        unavailableTools: ALL_TOOLS_AVAILABLE
      })
    })

    it("reads at once when no read is in flight", async () => {
      startNativeHostFake({ list_tools: () => [] })
      const backend = startBackendOfferingReadPageFrom(1)
      const useToolStore = await loadFreshToolStore()

      await useToolStore.getState().loadToolsAgain()

      expect(backend.requests).toHaveLength(1)
      expect(useToolStore.getState().list.status).toBe("loaded")
    })
  })

  describe("registerToolListRefresh", () => {
    /** vmo transitions in order, and whether each reads the list again. */
    const VMO_TRANSITIONS = [
      { vmoServerInfo: { status: "starting", problem: null }, reads: false },
      { vmoServerInfo: { status: "running", problem: null }, reads: true },
      { vmoServerInfo: { status: "stopping", problem: null }, reads: false },
      {
        vmoServerInfo: { status: "stopped", problem: { kind: "killed" } },
        reads: true
      },
      { vmoServerInfo: { status: "unresponsive", problem: null }, reads: true }
    ] as const

    /**
     * Starts the tool list's hosts, loads fresh stores with the backend in
     * the given state, and registers the refresh until the case ends,
     * without reading the list.
     *
     * @param backendStatus - Backend lifecycle state to publish first.
     * @returns The stores, the backend observation handle, and the
     * unsubscribe the registration returned.
     */
    async function startRefreshOfUnreadList(
      backendStatus: BackendServerStatus
    ) {
      startNativeHostFake({ list_tools: () => [] })
      const backend = startBackendOfferingReadPageFrom(1)
      const stores = await loadFreshToolStores()
      stores.useLysStore.setState({
        backendServerInfo: { status: backendStatus }
      })
      const unsubscribe = stores.registerToolListRefresh()
      onTestFinished(unsubscribe)
      return { ...stores, backend, unsubscribe }
    }

    /**
     * Starts the refresh as {@link startRefreshOfUnreadList} does, then reads
     * the list once, so the backend has answered one read.
     *
     * @param backendStatus - Backend lifecycle state to publish first.
     * @returns The stores, the backend observation handle, and the
     * unsubscribe the registration returned.
     */
    async function startRefresh(backendStatus: BackendServerStatus) {
      const refresh = await startRefreshOfUnreadList(backendStatus)
      await refresh.useToolStore.getState().loadTools()
      return refresh
    }

    it("reads a list already read again when vmo starts running, stops, or stops answering while the backend runs", async () => {
      const { useLysStore, useToolStore, backend } =
        await startRefresh("running")
      const readsAfterEach: number[] = []

      for (const { vmoServerInfo } of VMO_TRANSITIONS) {
        useLysStore.setState({ vmoServerInfo })
        await vi.waitFor(() => {
          expect(useToolStore.getState().list.status).not.toBe("loading")
        })
        readsAfterEach.push(backend.requests.length)
      }

      expect(readsAfterEach).toEqual([1, 2, 2, 3, 4])
    })

    it("reads a list already read again when the backend starts running", async () => {
      const { useLysStore, useToolStore, backend } =
        await startRefresh("starting")

      useLysStore.setState({ backendServerInfo: { status: "running" } })
      await vi.waitFor(() => {
        expect(backend.requests).toHaveLength(2)
        expect(useToolStore.getState().list.status).toBe("loaded")
      })

      expect(useToolStore.getState().list).toEqual({
        status: "loaded",
        tools: [READ_PAGE],
        unavailableTools: ALL_TOOLS_AVAILABLE
      })
    })

    it("reads nothing while the backend is not running", async () => {
      const { useLysStore, backend } = await startRefresh("stopped")

      useLysStore.setState({ backendServerInfo: { status: "starting" } })
      for (const { vmoServerInfo } of VMO_TRANSITIONS) {
        useLysStore.setState({ vmoServerInfo })
      }
      await waitForMicrotasks()

      expect(backend.requests).toHaveLength(1)
    })

    it("leaves a list never read alone, for whoever needs it first to read", async () => {
      const { useLysStore, useToolStore, backend } =
        await startRefreshOfUnreadList("stopped")

      useLysStore.setState({ backendServerInfo: { status: "running" } })
      useLysStore.setState({
        vmoServerInfo: { status: "running", problem: null }
      })
      await waitForMicrotasks()

      expect(backend.requests).toHaveLength(0)
      expect(useToolStore.getState().list.status).toBe("idle")
    })

    it("reads nothing once unsubscribed", async () => {
      const { useLysStore, backend, unsubscribe } =
        await startRefresh("running")

      unsubscribe()
      useLysStore.setState({
        vmoServerInfo: { status: "running", problem: null }
      })
      useLysStore.setState({ backendServerInfo: { status: "stopped" } })
      useLysStore.setState({ backendServerInfo: { status: "running" } })
      await waitForMicrotasks()

      expect(backend.requests).toHaveLength(1)
    })
  })
})
