import { describe, expect, it } from "vitest"
import { createStore } from "zustand/vanilla"
import type { LysSettings } from "@/lib/store/settings"
import { createSettingsGroupSaves } from "@/lib/store/settings-group-saves"
import {
  createToolSettingsSlice,
  getToolApproval,
  isToolSettingsEqual,
  type ToolSettingsSlice
} from "@/lib/store/tool-settings"
import { startNativeHostFake } from "../../support/nativeHostFake"
import {
  createControlledPromise,
  waitForMicrotasks,
  type ControlledPromise
} from "../../support/settlement"
import {
  STORED_SETTINGS,
  STORED_SETTINGS_DOCUMENT
} from "../../support/settingsFixtures"

/** Store state the slice borrows: the current settings and the slice. */
type ToolSettingsStore = ToolSettingsSlice & { settings: LysSettings }

/**
 * Creates a store holding the stored settings, in which `read_page` is on
 * Just run.
 *
 * @returns A store owning one tool-settings slice, whose saves run through
 * the application's settings-group saves over the native host.
 */
function createToolSettingsStore() {
  const settingsGroupSaves = createSettingsGroupSaves()
  return createStore<ToolSettingsStore>()((set, get) => ({
    settings: STORED_SETTINGS,
    ...createToolSettingsSlice(set, get, settingsGroupSaves)
  }))
}

/**
 * Starts a native host that loads the stored settings document and whose
 * settings writes stay pending until the case settles them, one controlled
 * promise per write.
 *
 * @returns The host observation handle and the pending writes in order.
 */
function startControlledSettingsHost() {
  const writes: ControlledPromise<null>[] = []
  const host = startNativeHostFake({
    load_settings: () => STORED_SETTINGS_DOCUMENT,
    save_settings: () => {
      const write = createControlledPromise<null>()
      writes.push(write)
      return write.promise
    }
  })
  return { host, writes }
}

/**
 * Lists the arguments of every settings write, in order.
 *
 * @param commands - Native commands the host observed.
 * @returns The arguments each `save_settings` call carried.
 */
function listSettingsWrites(
  commands: readonly { command: string; args: unknown }[]
): unknown[] {
  return commands
    .filter((invoked) => invoked.command === "save_settings")
    .map((invoked) => invoked.args)
}

/**
 * Builds the arguments of a write that keeps the stored document and
 * replaces its tools group.
 *
 * @param justRun - Names on Just run, in the order the write lists them.
 * @returns The expected `save_settings` arguments.
 */
function buildToolsWrite(justRun: readonly string[]) {
  return { newSettings: { ...STORED_SETTINGS_DOCUMENT, tools: { justRun } } }
}

describe("getToolApproval", () => {
  it("is Just run for a saved name and Ask me for any other", () => {
    const justRunToolNames = new Set(["read_page"])

    expect(getToolApproval(justRunToolNames, "read_page")).toBe("run")
    expect(getToolApproval(justRunToolNames, "web_search")).toBe("ask")
    expect(getToolApproval(new Set(), "read_page")).toBe("ask")
  })
})

describe("isToolSettingsEqual", () => {
  it("compares the names on Just run, whatever their order", () => {
    const first = { justRunToolNames: new Set(["read_page", "find_files"]) }

    expect(
      isToolSettingsEqual(first, {
        justRunToolNames: new Set(["find_files", "read_page"])
      })
    ).toBe(true)
    expect(
      isToolSettingsEqual(first, { justRunToolNames: new Set(["read_page"]) })
    ).toBe(false)
    expect(
      isToolSettingsEqual(first, {
        justRunToolNames: new Set(["read_page", "web_search"])
      })
    ).toBe(false)
  })
})

describe("createToolSettingsSlice", () => {
  it("starts with no save", () => {
    const store = createToolSettingsStore()

    expect(store.getState().toolSettingsSave).toEqual({ status: "idle" })
  })

  describe("updateToolApproval", () => {
    it("puts a tool on Just run at once, then saves it with the names already saved", async () => {
      const { host, writes } = startControlledSettingsHost()
      const store = createToolSettingsStore()

      store.getState().updateToolApproval("find_files", "run")
      const appliedAtOnce = store.getState().settings.tools.justRunToolNames
      await waitForMicrotasks()
      const whileWriting = store.getState().toolSettingsSave
      writes[0]?.resolve(null)
      await waitForMicrotasks()

      expect(appliedAtOnce).toEqual(new Set(["read_page", "find_files"]))
      expect(whileWriting).toEqual({ status: "saving" })
      expect(store.getState().toolSettingsSave).toEqual({ status: "saved" })
      expect(listSettingsWrites(host.commands)).toEqual([
        buildToolsWrite(["read_page", "find_files"])
      ])
    })

    it("removes a tool switched back to Ask me from the saved names", async () => {
      const { host, writes } = startControlledSettingsHost()
      const store = createToolSettingsStore()

      store.getState().updateToolApproval("read_page", "ask")
      await waitForMicrotasks()
      writes[0]?.resolve(null)
      await waitForMicrotasks()

      expect(store.getState().settings.tools.justRunToolNames).toEqual(
        new Set()
      )
      expect(listSettingsWrites(host.commands)).toEqual([buildToolsWrite([])])
    })

    it("changes and saves nothing when the tool already has that approval", async () => {
      const { host } = startControlledSettingsHost()
      const store = createToolSettingsStore()
      const before = store.getState().settings

      store.getState().updateToolApproval("read_page", "run")
      store.getState().updateToolApproval("web_search", "ask")
      await waitForMicrotasks()

      expect(store.getState().settings).toBe(before)
      expect(store.getState().toolSettingsSave).toEqual({ status: "idle" })
      expect(host.commands).toEqual([])
    })

    it("keeps the change for the session and reports the failure when it cannot be saved", async () => {
      const { writes } = startControlledSettingsHost()
      const store = createToolSettingsStore()

      store.getState().updateToolApproval("read_page", "ask")
      await waitForMicrotasks()
      writes[0]?.reject("Disk full")
      await waitForMicrotasks()

      expect(store.getState().toolSettingsSave).toEqual({ status: "failed" })
      expect(store.getState().settings.tools.justRunToolNames).toEqual(
        new Set()
      )
    })

    it("saves a change made while an earlier save is written, after it", async () => {
      const { host, writes } = startControlledSettingsHost()
      const store = createToolSettingsStore()

      store.getState().updateToolApproval("find_files", "run")
      await waitForMicrotasks()
      store.getState().updateToolApproval("read_page", "ask")
      const writesDuringFirst = writes.length
      writes[0]?.resolve(null)
      await waitForMicrotasks()
      writes[1]?.resolve(null)
      await waitForMicrotasks()

      expect(writesDuringFirst).toBe(1)
      expect(listSettingsWrites(host.commands)).toEqual([
        buildToolsWrite(["read_page", "find_files"]),
        buildToolsWrite(["find_files"])
      ])
      expect(store.getState().toolSettingsSave).toEqual({ status: "saved" })
    })
  })

  describe("saveToolSettings", () => {
    it("writes the current choices again after a failed save", async () => {
      const { host, writes } = startControlledSettingsHost()
      const store = createToolSettingsStore()
      store.getState().updateToolApproval("find_files", "run")
      await waitForMicrotasks()
      writes[0]?.reject("Disk full")
      await waitForMicrotasks()

      const retry = store.getState().saveToolSettings()
      await waitForMicrotasks()
      writes[1]?.resolve(null)
      await retry

      expect(store.getState().toolSettingsSave).toEqual({ status: "saved" })
      expect(listSettingsWrites(host.commands)).toEqual([
        buildToolsWrite(["read_page", "find_files"]),
        buildToolsWrite(["read_page", "find_files"])
      ])
    })
  })
})
