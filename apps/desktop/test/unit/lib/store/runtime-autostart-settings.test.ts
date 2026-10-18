import { describe, expect, it } from "vitest"
import { createStore } from "zustand/vanilla"
import {
  createRuntimeAutoStartSettingsSlice,
  isRuntimeAutoStartSettingsEqual,
  type RuntimeAutoStartSettingsSlice
} from "@/lib/store/runtime-autostart-settings"
import type { LysSettings, RuntimeSettings } from "@/lib/store/settings"
import { createSettingsGroupSaves } from "@/lib/store/settings-group-saves"
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
type RuntimeAutoStartSettingsStore = RuntimeAutoStartSettingsSlice & {
  settings: LysSettings
}

/**
 * Creates a store holding the stored settings, in which both startup
 * switches are off.
 *
 * @returns A store owning one runtime-autostart slice, whose saves run
 * through the application's settings-group saves over the native host.
 */
function createRuntimeAutoStartStore() {
  const settingsGroupSaves = createSettingsGroupSaves()
  return createStore<RuntimeAutoStartSettingsStore>()((set, get) => ({
    settings: STORED_SETTINGS,
    ...createRuntimeAutoStartSettingsSlice(set, get, settingsGroupSaves)
  }))
}

/**
 * Replaces the startup switches the store holds, as the Runtime pane does.
 *
 * @param store - Store under test.
 * @param switches - Switches to apply in memory.
 */
function applyStartupSwitches(
  store: ReturnType<typeof createRuntimeAutoStartStore>,
  switches: Pick<RuntimeSettings, "autoStartBackend" | "autoStartVmo">
): void {
  store.setState((state) => ({
    settings: {
      ...state.settings,
      runtime: { ...state.settings.runtime, ...switches }
    }
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
 * replaces its startup switches.
 *
 * @param autoStartBackend - Backend startup switch.
 * @param autoStartVmo - vmo startup switch.
 * @returns The expected `save_settings` arguments.
 */
function buildRuntimeWrite(autoStartBackend: boolean, autoStartVmo: boolean) {
  return {
    newSettings: {
      ...STORED_SETTINGS_DOCUMENT,
      runtime: {
        ...STORED_SETTINGS_DOCUMENT.runtime,
        autoStartBackend,
        autoStartVmo
      }
    }
  }
}

describe("isRuntimeAutoStartSettingsEqual", () => {
  it("compares only the two startup switches", () => {
    const runtime = STORED_SETTINGS.runtime
    const otherSessionFields: RuntimeSettings = {
      ...runtime,
      defaultModel: "another",
      backendAddress: "http://127.0.0.1:1"
    }

    expect(isRuntimeAutoStartSettingsEqual(runtime, otherSessionFields)).toBe(
      true
    )
    expect(
      isRuntimeAutoStartSettingsEqual(runtime, {
        ...runtime,
        autoStartBackend: true
      })
    ).toBe(false)
    expect(
      isRuntimeAutoStartSettingsEqual(runtime, {
        ...runtime,
        autoStartVmo: true
      })
    ).toBe(false)
  })
})

describe("createRuntimeAutoStartSettingsSlice", () => {
  it("starts with no save", () => {
    const store = createRuntimeAutoStartStore()

    expect(store.getState().runtimeAutoStartSave).toEqual({ status: "idle" })
  })

  it("saves the current switches with the rest of the document as it is on disk, and reports the save", async () => {
    const { host, writes } = startControlledSettingsHost()
    const store = createRuntimeAutoStartStore()
    applyStartupSwitches(store, { autoStartBackend: true, autoStartVmo: false })

    const save = store.getState().saveRuntimeAutoStartSettings()
    await waitForMicrotasks()
    const whileWriting = store.getState().runtimeAutoStartSave
    writes[0]?.resolve(null)
    await save

    expect(whileWriting).toEqual({ status: "saving" })
    expect(store.getState().runtimeAutoStartSave).toEqual({ status: "saved" })
    expect(listSettingsWrites(host.commands)).toEqual([
      buildRuntimeWrite(true, false)
    ])
  })

  it("saves a change made while an earlier save is written, after it, so the latest switches win", async () => {
    const { host, writes } = startControlledSettingsHost()
    const store = createRuntimeAutoStartStore()
    applyStartupSwitches(store, { autoStartBackend: true, autoStartVmo: false })

    const save = store.getState().saveRuntimeAutoStartSettings()
    await waitForMicrotasks()
    applyStartupSwitches(store, { autoStartBackend: true, autoStartVmo: true })
    const joined = store.getState().saveRuntimeAutoStartSettings()
    const writesDuringFirst = writes.length
    writes[0]?.resolve(null)
    await waitForMicrotasks()
    writes[1]?.resolve(null)
    await Promise.all([save, joined])

    expect(writesDuringFirst).toBe(1)
    expect(listSettingsWrites(host.commands)).toEqual([
      buildRuntimeWrite(true, false),
      buildRuntimeWrite(true, true)
    ])
    expect(store.getState().runtimeAutoStartSave).toEqual({ status: "saved" })
  })

  it("keeps the switches for the session and reports the failure when they cannot be saved", async () => {
    const { writes } = startControlledSettingsHost()
    const store = createRuntimeAutoStartStore()
    applyStartupSwitches(store, { autoStartBackend: false, autoStartVmo: true })

    const save = store.getState().saveRuntimeAutoStartSettings()
    await waitForMicrotasks()
    writes[0]?.reject("Disk full")
    await save

    expect(store.getState().runtimeAutoStartSave).toEqual({ status: "failed" })
    expect(store.getState().settings.runtime.autoStartVmo).toBe(true)
  })
})
