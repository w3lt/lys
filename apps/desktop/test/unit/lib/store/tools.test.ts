import type { ToolDefinition } from "@lys/share"
import { describe, expect, it, vi } from "vitest"
import {
  buildChatToolOffer,
  getToolChoice,
  type ToolChoice,
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

/** Route key of the backend's tool list. */
const BACKEND_TOOLS_ROUTE = "GET /api/v1/tools"

/**
 * Builds the backend's tool-list route.
 *
 * @param tools - Tools the backend lists.
 * @returns The route answering with them.
 */
function buildBackendToolsRoute(
  tools: readonly ToolDefinition[] = [READ_PAGE]
): BackendRoute {
  return () => buildJsonResponse(200, { tools })
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

describe("getToolChoice", () => {
  it("returns the choice the person changed", () => {
    const choice = { isOn: false, approval: "ask" } as const
    const findFiles = buildToolDefinition("find_files")

    expect(getToolChoice(new Map([["find_files", choice]]), findFiles)).toBe(
      choice
    )
  })

  it("returns on and asking first for an unchanged tool that only reads this machine", () => {
    expect(getToolChoice(new Map(), buildToolDefinition("find_files"))).toEqual(
      { isOn: true, approval: "ask" }
    )
  })

  it("returns off and asking first for an unchanged tool that sends requests off this machine", () => {
    expect(getToolChoice(new Map(), READ_PAGE)).toEqual({
      isOn: false,
      approval: "ask"
    })
  })
})

/** Choice of a tool the person switched off. */
const SWITCHED_OFF: ToolChoice = Object.freeze({
  isOn: false,
  approval: "ask"
})

/** Choice of a tool the person switched on. */
const SWITCHED_ON: ToolChoice = Object.freeze({
  isOn: true,
  approval: "ask"
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
          tools: [readTextFile, findFiles, searchFiles, READ_PAGE]
        },
        toolChoices: new Map([["read_text_file", SWITCHED_OFF]])
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
        list: { status: "loaded", tools: [findFiles, READ_PAGE] },
        toolChoices: new Map([["read_page", SWITCHED_ON]])
      })
    ).toEqual({
      status: "offered",
      offer: { definitions: [findFiles], backendToolNames: ["read_page"] }
    })
  })

  it.each([
    ["every listed tool is switched off", [...CLIENT_TOOLS, READ_PAGE]],
    ["only an unchanged backend tool is listed", [READ_PAGE]],
    ["no tool is listed", []]
  ])("offers no tools when %s", (_label, tools) => {
    expect(
      buildChatToolOffer({
        list: { status: "loaded", tools },
        toolChoices: new Map([
          ["read_text_file", SWITCHED_OFF],
          ["find_files", SWITCHED_OFF]
        ])
      })
    ).toEqual({ status: "not-offered" })
  })

  it("reports the failed read's reason and how to chat without tools", () => {
    const reason = "Lys couldn't read its tool list: bad name."

    expect(
      buildChatToolOffer({
        list: { status: "failed", error: reason },
        toolChoices: new Map()
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
      expect(buildChatToolOffer({ list, toolChoices: new Map() })).toEqual({
        status: "unavailable",
        error: expect.stringMatching(
          /^Lys couldn't read its tool list\. .*Turn tool calls off in Settings → Tools/
        )
      })
    }
  )
})

describe("useToolStore", () => {
  it("starts with no list, tool calls on, and no changed choice", async () => {
    const useToolStore = await loadFreshToolStore()

    expect(useToolStore.getState()).toMatchObject({
      list: { status: "idle" },
      areToolCallsOn: true,
      toolChoices: new Map()
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
        tools: [...CLIENT_TOOLS, READ_PAGE]
      })
      expect(backend.requests.map((request) => request.url)).toEqual([
        "http://127.0.0.1:12345/api/v1/tools"
      ])
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

  it("switches one tool off and keeps its approval", async () => {
    const useToolStore = await loadFreshToolStore()
    const findFiles = buildToolDefinition("find_files")
    useToolStore.getState().updateToolApproval(findFiles, "run")

    useToolStore.getState().updateToolOn(findFiles, false)

    expect(
      getToolChoice(useToolStore.getState().toolChoices, findFiles)
    ).toEqual({ isOn: false, approval: "run" })
  })

  it("changes one tool's approval and keeps whether it is on", async () => {
    const useToolStore = await loadFreshToolStore()
    const findFiles = buildToolDefinition("find_files")
    useToolStore.getState().updateToolOn(findFiles, false)

    useToolStore.getState().updateToolApproval(findFiles, "run")

    expect(
      getToolChoice(useToolStore.getState().toolChoices, findFiles)
    ).toEqual({ isOn: false, approval: "run" })
  })

  it("keeps a backend tool off when only its approval changes", async () => {
    const useToolStore = await loadFreshToolStore()

    useToolStore.getState().updateToolApproval(READ_PAGE, "run")

    expect(
      getToolChoice(useToolStore.getState().toolChoices, READ_PAGE)
    ).toEqual({ isOn: false, approval: "run" })
  })

  it("leaves other tools and earlier choice snapshots unchanged", async () => {
    const useToolStore = await loadFreshToolStore()
    const before = useToolStore.getState().toolChoices

    useToolStore
      .getState()
      .updateToolOn(buildToolDefinition("find_files"), false)
    await waitForMicrotasks()

    expect(
      getToolChoice(
        useToolStore.getState().toolChoices,
        buildToolDefinition("read_text_file")
      )
    ).toEqual({ isOn: true, approval: "ask" })
    expect(before.size).toBe(0)
  })
})
