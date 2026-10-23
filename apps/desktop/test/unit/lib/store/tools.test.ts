import type {
  BackendToolUnavailableReason,
  UnavailableBackendTool
} from "@lys/protocol"
import type { ToolDefinition } from "@lys/share"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import type { BackendServerInfo, BackendServerStatus } from "@/lib/store"
import {
  buildChatToolFields,
  buildChatToolOffer,
  getToolChoice,
  isToolOn,
  NO_CHAT_TOOL_OFFER,
  type ChatToolFields,
  type ChatToolOfferResult,
  type ToolListState
} from "@/lib/store/tools"
import type { VmoProblem, VmoServerInfo } from "@/lib/store/vmo-runtime"
import {
  buildJsonResponse,
  startBackendFake,
  type BackendRoute
} from "../../support/backendFake"
import { startNativeHostFake } from "../../support/nativeHostFake"
import {
  createControlledPromise,
  createSettlementReader,
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

/** `read_page` as the backend lists it while vmo cannot read pages yet. */
const READ_PAGE_NOT_READY: UnavailableBackendTool = Object.freeze({
  name: "read_page",
  reason: "page-reader-not-ready"
})

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
        unavailableTools: reads >= firstReadyRead ? [] : [READ_PAGE_NOT_READY]
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
  it("combines the saved switch with the saved approval", () => {
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
  it("offers every desktop tool the person has not switched off, in list order, and names every tool that is off", () => {
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
        areToolCallsOn: true,
        toolSwitches: new Map([["read_text_file", false]])
      })
    ).toEqual({
      status: "offered",
      offer: { definitions: [findFiles, searchFiles] },
      switchedOffToolNames: ["read_text_file", "read_page"]
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
        areToolCallsOn: true,
        toolSwitches: new Map([["read_page", true]])
      })
    ).toEqual({
      status: "offered",
      offer: { definitions: [findFiles], backendToolNames: ["read_page"] },
      switchedOffToolNames: []
    })
  })

  it("leaves out a switched-on backend tool that cannot run now, without naming it as off", () => {
    expect(
      buildChatToolOffer({
        list: {
          status: "loaded",
          tools: [READ_PAGE, WEB_SEARCH],
          unavailableTools: new Map([["web_search", "api-key-missing"]])
        },
        areToolCallsOn: true,
        toolSwitches: new Map([
          ["read_page", true],
          ["web_search", true]
        ])
      })
    ).toEqual({
      status: "offered",
      offer: { definitions: [], backendToolNames: ["read_page"] },
      switchedOffToolNames: []
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
        areToolCallsOn: true,
        toolSwitches: new Map([["web_search", true]])
      })
    ).toEqual({ status: "not-offered", switchedOffToolNames: [] })
  })

  it.each([
    [
      "every listed tool is switched off",
      [...CLIENT_TOOLS, READ_PAGE],
      ["read_text_file", "find_files", "read_page"]
    ],
    ["only an unchanged backend tool is listed", [READ_PAGE], ["read_page"]],
    ["no tool is listed", [], []]
  ])("offers no tools when %s", (_label, tools, switchedOffToolNames) => {
    expect(
      buildChatToolOffer({
        list: {
          status: "loaded",
          tools,
          unavailableTools: ALL_TOOLS_AVAILABLE
        },
        areToolCallsOn: true,
        toolSwitches: new Map([
          ["read_text_file", false],
          ["find_files", false]
        ])
      })
    ).toEqual({ status: "not-offered", switchedOffToolNames })
  })

  it("offers no tools and names every listed tool as off while tool calls are off, whatever each tool's switch says", () => {
    const findFiles = buildToolDefinition("find_files")

    expect(
      buildChatToolOffer({
        list: {
          status: "loaded",
          tools: [findFiles, READ_PAGE, WEB_SEARCH],
          unavailableTools: new Map([["web_search", "api-key-missing"]])
        },
        areToolCallsOn: false,
        toolSwitches: new Map([
          ["read_page", true],
          ["web_search", true]
        ])
      })
    ).toEqual({
      status: "not-offered",
      switchedOffToolNames: ["find_files", "read_page", "web_search"]
    })
  })

  it.each([
    ...UNREAD_TOOL_LISTS,
    Object.freeze({ status: "failed", error: "Lys couldn't read it." })
  ] satisfies readonly ToolListState[])(
    "offers and names no tools while tool calls are off and the list is $status",
    (list) => {
      expect(
        buildChatToolOffer({
          list,
          areToolCallsOn: false,
          toolSwitches: new Map()
        })
      ).toBe(NO_CHAT_TOOL_OFFER)
    }
  )

  it("reports the failed read's reason and how to chat without tools", () => {
    const reason = "Lys couldn't read its tool list: bad name."

    expect(
      buildChatToolOffer({
        list: { status: "failed", error: reason },
        areToolCallsOn: true,
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
      expect(
        buildChatToolOffer({
          list,
          areToolCallsOn: true,
          toolSwitches: new Map()
        })
      ).toEqual({
        status: "unavailable",
        error: expect.stringMatching(
          /^Lys couldn't read its tool list\. .*Turn tool calls off in Settings → Tools/
        )
      })
    }
  )
})

describe("buildChatToolFields", () => {
  const offer = Object.freeze({ definitions: CLIENT_TOOLS })

  it.each<[string, ChatToolOfferResult, ChatToolFields]>([
    [
      "offered tools and switched-off tools",
      { status: "offered", offer, switchedOffToolNames: ["read_page"] },
      { tools: offer, switchedOffToolNames: ["read_page"] }
    ],
    [
      "offered tools alone",
      { status: "offered", offer, switchedOffToolNames: [] },
      { tools: offer }
    ],
    [
      "switched-off tools alone",
      { status: "not-offered", switchedOffToolNames: ["read_page"] },
      { switchedOffToolNames: ["read_page"] }
    ],
    ["neither", NO_CHAT_TOOL_OFFER, {}],
    [
      "nothing for an unavailable list",
      { status: "unavailable", error: "x" },
      {}
    ]
  ])("sends %s", (_label, toolOffer, fields) => {
    expect(buildChatToolFields(toolOffer)).toStrictEqual(fields)
  })
})

describe("useToolStore", () => {
  it("starts with no list and tool calls on", async () => {
    const useToolStore = await loadFreshToolStore()

    expect(useToolStore.getState()).toMatchObject({
      list: { status: "idle" },
      areToolCallsOn: true
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

    it("joins a further call made while it waits into the same next read, while loadTools joins the read in flight", async () => {
      const firstClientList = createControlledPromise<unknown>()
      const nextClientList = createControlledPromise<unknown>()
      let clientReads = 0
      const host = startNativeHostFake({
        list_tools: () => {
          clientReads += 1
          return clientReads === 1
            ? firstClientList.promise
            : nextClientList.promise
        }
      })
      const backend = startBackendOfferingReadPageFrom(2)
      const useToolStore = await loadFreshToolStore()
      const toolStore = useToolStore.getState()

      const first = toolStore.loadTools()
      const waitingCalls = Promise.all([
        toolStore.loadToolsAgain(),
        toolStore.loadToolsAgain()
      ])
      const readJoiningFirst = createSettlementReader(toolStore.loadTools())
      const waitingSettlement = createSettlementReader(waitingCalls)
      firstClientList.resolve([])
      await first
      await waitForMicrotasks()
      const settlementsAfterFirstRead = {
        readJoiningFirst: readJoiningFirst(),
        waitingCalls: waitingSettlement()
      }
      nextClientList.resolve([])
      await waitingCalls

      expect(settlementsAfterFirstRead).toEqual({
        readJoiningFirst: "fulfilled",
        waitingCalls: "pending"
      })
      expect(host.commands).toHaveLength(2)
      expect(backend.requests).toHaveLength(2)
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
    /** Backend whose start is pending. */
    const STARTING_BACKEND: BackendServerInfo = Object.freeze({
      status: "starting"
    })

    /** Backend whose health route answered. */
    const RUNNING_BACKEND: BackendServerInfo = Object.freeze({
      status: "running"
    })

    /** Backend that does not run. */
    const STOPPED_BACKEND: BackendServerInfo = Object.freeze({
      status: "stopped"
    })

    /** vmo while its start is pending. */
    const STARTING_VMO: VmoServerInfo = Object.freeze({
      status: "starting",
      problem: null
    })

    /** vmo answering its health route. */
    const RUNNING_VMO: VmoServerInfo = Object.freeze({
      status: "running",
      problem: null
    })

    /** vmo while a stop waits for it to exit. */
    const STOPPING_VMO: VmoServerInfo = Object.freeze({
      status: "stopping",
      problem: null
    })

    /** Problem of a vmo killed after the stop timeout. */
    const KILLED_PROBLEM: VmoProblem = Object.freeze({ kind: "killed" })

    /** vmo killed after the stop timeout. */
    const KILLED_VMO: VmoServerInfo = Object.freeze({
      status: "stopped",
      problem: KILLED_PROBLEM
    })

    /** vmo that runs without answering its health route. */
    const UNRESPONSIVE_VMO: VmoServerInfo = Object.freeze({
      status: "unresponsive",
      problem: null
    })

    /** vmo transitions in order, and whether each reads the list again. */
    const VMO_TRANSITIONS = [
      { vmoServerInfo: STARTING_VMO, reads: false },
      { vmoServerInfo: RUNNING_VMO, reads: true },
      { vmoServerInfo: STOPPING_VMO, reads: false },
      { vmoServerInfo: KILLED_VMO, reads: true },
      { vmoServerInfo: UNRESPONSIVE_VMO, reads: true }
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
      const { useToolStore, useLysStore, registerToolListRefresh } =
        await loadFreshToolStores()
      const backendServerInfo: BackendServerInfo = { status: backendStatus }
      useLysStore.setState({ backendServerInfo })
      const unsubscribe = registerToolListRefresh()
      onTestFinished(unsubscribe)
      return { useToolStore, useLysStore, backend, unsubscribe }
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

      useLysStore.setState({ backendServerInfo: RUNNING_BACKEND })
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

      useLysStore.setState({ backendServerInfo: STARTING_BACKEND })
      for (const { vmoServerInfo } of VMO_TRANSITIONS) {
        useLysStore.setState({ vmoServerInfo })
      }
      await waitForMicrotasks()

      expect(backend.requests).toHaveLength(1)
    })

    it("leaves a list never read alone, for whoever needs it first to read", async () => {
      const { useLysStore, useToolStore, backend } =
        await startRefreshOfUnreadList("stopped")

      useLysStore.setState({ backendServerInfo: RUNNING_BACKEND })
      useLysStore.setState({ vmoServerInfo: RUNNING_VMO })
      await waitForMicrotasks()

      expect(backend.requests).toHaveLength(0)
      expect(useToolStore.getState().list.status).toBe("idle")
    })

    it("reads nothing once unsubscribed", async () => {
      const { useLysStore, backend, unsubscribe } =
        await startRefresh("running")

      unsubscribe()
      useLysStore.setState({ vmoServerInfo: RUNNING_VMO })
      useLysStore.setState({ backendServerInfo: STOPPED_BACKEND })
      useLysStore.setState({ backendServerInfo: RUNNING_BACKEND })
      await waitForMicrotasks()

      expect(backend.requests).toHaveLength(1)
    })
  })
})
