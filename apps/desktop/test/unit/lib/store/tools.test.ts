import { describe, expect, it, vi } from "vitest"
import { getToolChoice } from "@/lib/store/tools"
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
 * Imports a fresh tool store, so no list or choice of another case reaches
 * this one.
 *
 * @returns The store hook of a newly evaluated store module.
 */
async function importFreshToolStore() {
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

  it("returns on and run at once for a tool the person has not changed", () => {
    expect(getToolChoice(new Map(), "find_files")).toEqual({
      isOn: true,
      approval: "run"
    })
  })
})

describe("useToolStore", () => {
  it("starts with no list, tool calls on, eight calls per reply, and no changed choice", async () => {
    const useToolStore = await importFreshToolStore()

    expect(useToolStore.getState()).toMatchObject({
      list: { status: "idle" },
      areToolCallsOn: true,
      callsPerReply: 8,
      toolChoices: new Map()
    })
  })

  describe("loadTools", () => {
    it("shows loading while the desktop reads the list, then the list", async () => {
      const list = createControlledPromise<unknown>()
      startNativeHostFake({ list_tools: () => list.promise })
      const useToolStore = await importFreshToolStore()

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
      const useToolStore = await importFreshToolStore()

      const first = useToolStore.getState().loadTools()
      const second = useToolStore.getState().loadTools()
      list.resolve(TOOLS)
      await Promise.all([first, second])

      expect(host.commands).toHaveLength(1)
    })

    it("starts a new read once the previous one settled", async () => {
      const host = startNativeHostFake({ list_tools: () => TOOLS })
      const useToolStore = await importFreshToolStore()
      await useToolStore.getState().loadTools()

      await useToolStore.getState().loadTools()

      expect(host.commands).toHaveLength(2)
    })

    it("shows a general failure when the desktop rejects without a reason", async () => {
      startNativeHostFake({
        list_tools: () => Promise.reject("command list_tools not found")
      })
      const useToolStore = await importFreshToolStore()

      await expect(useToolStore.getState().loadTools()).resolves.toBeUndefined()

      expect(useToolStore.getState().list).toEqual({
        status: "failed",
        error: "Lys couldn't read its tool list."
      })
    })

    it("names the reason when the read fails with one", async () => {
      startNativeHostFake({ list_tools: () => [{ name: "bad name!" }] })
      const useToolStore = await importFreshToolStore()

      await useToolStore.getState().loadTools()

      expect(useToolStore.getState().list).toMatchObject({
        status: "failed",
        error: expect.stringMatching(/^Lys couldn't read its tool list: .+/)
      })
    })
  })

  it("switches tool calls off and changes the calls per reply", async () => {
    const useToolStore = await importFreshToolStore()

    useToolStore.getState().updateToolCallsOn(false)
    useToolStore.getState().updateCallsPerReply(16)

    expect(useToolStore.getState()).toMatchObject({
      areToolCallsOn: false,
      callsPerReply: 16
    })
  })

  it("switches one tool off and keeps its approval", async () => {
    const useToolStore = await importFreshToolStore()
    useToolStore.getState().updateToolApproval("find_files", "ask")

    useToolStore.getState().updateToolOn("find_files", false)

    expect(
      getToolChoice(useToolStore.getState().toolChoices, "find_files")
    ).toEqual({ isOn: false, approval: "ask" })
  })

  it("changes one tool's approval and keeps whether it is on", async () => {
    const useToolStore = await importFreshToolStore()
    useToolStore.getState().updateToolOn("find_files", false)

    useToolStore.getState().updateToolApproval("find_files", "ask")

    expect(
      getToolChoice(useToolStore.getState().toolChoices, "find_files")
    ).toEqual({ isOn: false, approval: "ask" })
  })

  it("leaves other tools and earlier choice snapshots unchanged", async () => {
    const useToolStore = await importFreshToolStore()
    const before = useToolStore.getState().toolChoices

    useToolStore.getState().updateToolOn("find_files", false)
    await waitForMicrotasks()

    expect(
      getToolChoice(useToolStore.getState().toolChoices, "read_text_file")
    ).toEqual({ isOn: true, approval: "run" })
    expect(before.size).toBe(0)
  })
})
