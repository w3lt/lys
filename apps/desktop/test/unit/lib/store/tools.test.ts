import { describe, expect, it, vi } from "vitest"
import {
  buildChatToolOffer,
  getToolChoice,
  type ToolChoice,
  type ToolListState
} from "@/lib/store/tools"
import { startNativeHostFake } from "../../support/nativeHostFake"
import {
  createControlledPromise,
  waitForMicrotasks
} from "../../support/settlement"
import { buildToolDefinition } from "../../support/toolFixtures"

/** Tools the desktop lists, in Settings order. */
const TOOLS = [
  buildToolDefinition("read_text_file"),
  buildToolDefinition("find_files")
]

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

    expect(getToolChoice(new Map([["find_files", choice]]), "find_files")).toBe(
      choice
    )
  })

  it("returns on and asking first for a tool the person has not changed", () => {
    expect(getToolChoice(new Map(), "find_files")).toEqual({
      isOn: true,
      approval: "ask"
    })
  })
})

/** Choice of a tool the person switched off. */
const SWITCHED_OFF: ToolChoice = Object.freeze({
  isOn: false,
  approval: "ask"
})

/** Tool list states before a read has committed a list. */
const UNREAD_TOOL_LISTS: readonly ToolListState[] = Object.freeze([
  Object.freeze({ status: "idle" }),
  Object.freeze({ status: "loading" })
])

describe("buildChatToolOffer", () => {
  it("offers every tool the person has not switched off, in list order", () => {
    const readTextFile = buildToolDefinition("read_text_file")
    const findFiles = buildToolDefinition("find_files")
    const searchFiles = buildToolDefinition("search_files")

    expect(
      buildChatToolOffer({
        list: {
          status: "loaded",
          tools: [readTextFile, findFiles, searchFiles]
        },
        toolChoices: new Map([["read_text_file", SWITCHED_OFF]])
      })
    ).toEqual({
      status: "offered",
      offer: { definitions: [findFiles, searchFiles] }
    })
  })

  it.each([
    ["every listed tool is switched off", TOOLS],
    ["the desktop lists no tool", []]
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
    it("shows loading while the desktop reads the list, then the list", async () => {
      const list = createControlledPromise<unknown>()
      startNativeHostFake({ list_tools: () => list.promise })
      const useToolStore = await loadFreshToolStore()

      const load = useToolStore.getState().loadTools()
      const whileReading = useToolStore.getState().list
      list.resolve(TOOLS)
      await load

      expect(whileReading).toEqual({ status: "loading" })
      expect(useToolStore.getState().list).toEqual({
        status: "loaded",
        tools: TOOLS
      })
    })

    it("joins a read already in flight", async () => {
      const list = createControlledPromise<unknown>()
      const host = startNativeHostFake({ list_tools: () => list.promise })
      const useToolStore = await loadFreshToolStore()

      const first = useToolStore.getState().loadTools()
      const second = useToolStore.getState().loadTools()
      list.resolve(TOOLS)
      await Promise.all([first, second])

      expect(host.commands).toHaveLength(1)
    })

    it("starts a new read once the previous one settled", async () => {
      const host = startNativeHostFake({ list_tools: () => TOOLS })
      const useToolStore = await loadFreshToolStore()
      await useToolStore.getState().loadTools()

      await useToolStore.getState().loadTools()

      expect(host.commands).toHaveLength(2)
    })

    it("shows a general failure when the desktop rejects without a reason", async () => {
      startNativeHostFake({
        list_tools: () => Promise.reject("command list_tools not found")
      })
      const useToolStore = await loadFreshToolStore()

      await expect(useToolStore.getState().loadTools()).resolves.toBeUndefined()

      expect(useToolStore.getState().list).toEqual({
        status: "failed",
        error: "Lys couldn't read its tool list."
      })
    })

    it("names the reason when the read fails with one", async () => {
      startNativeHostFake({ list_tools: () => [{ name: "bad name!" }] })
      const useToolStore = await loadFreshToolStore()

      await useToolStore.getState().loadTools()

      expect(useToolStore.getState().list).toMatchObject({
        status: "failed",
        error: expect.stringMatching(/^Lys couldn't read its tool list: .+/)
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
    useToolStore.getState().updateToolApproval("find_files", "run")

    useToolStore.getState().updateToolOn("find_files", false)

    expect(
      getToolChoice(useToolStore.getState().toolChoices, "find_files")
    ).toEqual({ isOn: false, approval: "run" })
  })

  it("changes one tool's approval and keeps whether it is on", async () => {
    const useToolStore = await loadFreshToolStore()
    useToolStore.getState().updateToolOn("find_files", false)

    useToolStore.getState().updateToolApproval("find_files", "run")

    expect(
      getToolChoice(useToolStore.getState().toolChoices, "find_files")
    ).toEqual({ isOn: false, approval: "run" })
  })

  it("leaves other tools and earlier choice snapshots unchanged", async () => {
    const useToolStore = await loadFreshToolStore()
    const before = useToolStore.getState().toolChoices

    useToolStore.getState().updateToolOn("find_files", false)
    await waitForMicrotasks()

    expect(
      getToolChoice(useToolStore.getState().toolChoices, "read_text_file")
    ).toEqual({ isOn: true, approval: "ask" })
    expect(before.size).toBe(0)
  })
})
