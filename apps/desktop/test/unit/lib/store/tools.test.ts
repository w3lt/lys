import type {
  BackendToolUnavailableReason,
  UnavailableBackendTool
} from "@lys/protocol"
import type { ToolDefinition } from "@lys/share"
import { describe, expect, it, vi } from "vitest"
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
})
