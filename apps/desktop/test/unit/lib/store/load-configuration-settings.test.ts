import type { ModelLoadConfiguration } from "@lys/share"
import { describe, expect, it } from "vitest"
import { createStore } from "zustand/vanilla"
import {
  createLoadConfigurationSettingsSlice,
  type LoadConfigurationSettingsSlice
} from "@/lib/store/load-configuration-settings"
import type { LysSettings } from "@/lib/store/settings"
import { createSettingsGroupSaves } from "@/lib/store/settings-group-saves"
import { startNativeHostFake } from "../../support/nativeHostFake"
import {
  createControlledPromise,
  createSettlementReader,
  waitForMicrotasks,
  type ControlledPromise
} from "../../support/settlement"
import {
  STORED_SETTINGS,
  STORED_SETTINGS_DOCUMENT
} from "../../support/settingsFixtures"

/** Store state the slice borrows: the current settings and the slice. */
type LoadConfigurationStore = LoadConfigurationSettingsSlice & {
  settings: LysSettings
}

/** Load settings each model has of its own, by model key. */
type OwnLoadSettings = Readonly<Record<string, ModelLoadConfiguration>>

/**
 * Builds the stored settings with other per-model load settings in memory.
 *
 * @param models - Settings each model has of its own.
 * @returns Settings whose in-memory stored default differs from the one on
 * disk, so a write that carried it would be noticed.
 */
function buildSettings(models: OwnLoadSettings): LysSettings {
  return {
    ...STORED_SETTINGS,
    loadConfiguration: {
      default: { contextLength: 2048 },
      models: new Map(Object.entries(models))
    }
  }
}

/**
 * Creates a store holding the stored settings with the given per-model load
 * settings.
 *
 * @param models - Per-model load settings currently in memory.
 * @returns A store owning one load-configuration slice, whose saves run
 * through the application's settings-group saves over the native host.
 */
function createLoadConfigurationStore(models: OwnLoadSettings) {
  const settingsGroupSaves = createSettingsGroupSaves()
  return createStore<LoadConfigurationStore>()((set, get) => ({
    settings: buildSettings(models),
    ...createLoadConfigurationSettingsSlice(set, get, settingsGroupSaves)
  }))
}

/**
 * Edits the per-model load settings in memory, as the application store does
 * before it asks the slice to save.
 *
 * @param store - Store under test.
 * @param models - New per-model load settings.
 */
function updateLoadSettings(
  store: ReturnType<typeof createLoadConfigurationStore>,
  models: OwnLoadSettings
): void {
  store.setState({ settings: buildSettings(models) })
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
 * Builds the arguments of a write that replaces only the per-model load
 * settings of the document on disk, keeping its stored default and its
 * runtime, model, and generation groups.
 *
 * @param models - Per-model load settings the write must carry.
 * @returns The expected `save_settings` arguments.
 */
function buildSettingsWrite(models: OwnLoadSettings) {
  return {
    newSettings: {
      ...STORED_SETTINGS_DOCUMENT,
      loadConfiguration: {
        default: STORED_SETTINGS_DOCUMENT.loadConfiguration.default,
        models
      }
    }
  }
}

describe("createLoadConfigurationSettingsSlice", () => {
  it("starts idle", () => {
    const store = createLoadConfigurationStore({})

    expect(store.getState().loadConfigurationSave).toEqual({ status: "idle" })
  })

  it("reports saving until the write completes, then saved, keeping the stored default and the other groups on disk", async () => {
    const { host, writes } = startControlledSettingsHost()
    const store = createLoadConfigurationStore({
      "gemma-3": { evalBatchSize: 1024 }
    })

    const save = store.getState().saveLoadConfigurationSettings()
    await waitForMicrotasks()
    const duringWrite = store.getState().loadConfigurationSave
    writes[0]?.resolve(null)
    await save

    expect(duringWrite).toEqual({ status: "saving" })
    expect(store.getState().loadConfigurationSave).toEqual({ status: "saved" })
    expect(listSettingsWrites(host.commands)).toEqual([
      buildSettingsWrite({ "gemma-3": { evalBatchSize: 1024 } })
    ])
  })

  it("reports a failed write without its native detail and keeps the edit", async () => {
    startNativeHostFake({
      load_settings: () => STORED_SETTINGS_DOCUMENT,
      save_settings: () => Promise.reject("EACCES: /Users/secret/settings.json")
    })
    const store = createLoadConfigurationStore({
      "gemma-3": { evalBatchSize: 1024 }
    })

    await store.getState().saveLoadConfigurationSettings()

    expect(store.getState().loadConfigurationSave).toEqual({
      status: "failed"
    })
    expect(
      Object.fromEntries(store.getState().settings.loadConfiguration.models)
    ).toEqual({ "gemma-3": { evalBatchSize: 1024 } })
  })

  it("saves again when retried after a failure", async () => {
    let attempt = 0
    const host = startNativeHostFake({
      load_settings: () => STORED_SETTINGS_DOCUMENT,
      save_settings: () => {
        attempt += 1
        return attempt === 1 ? Promise.reject("Disk full") : null
      }
    })
    const store = createLoadConfigurationStore({
      "gemma-3": { evalBatchSize: 1024 }
    })
    await store.getState().saveLoadConfigurationSettings()

    await store.getState().saveLoadConfigurationSettings()

    expect(store.getState().loadConfigurationSave).toEqual({ status: "saved" })
    expect(listSettingsWrites(host.commands)).toHaveLength(2)
  })

  it("lets a save requested during a write return at once without a second concurrent write", async () => {
    const { host, writes } = startControlledSettingsHost()
    const store = createLoadConfigurationStore({
      "gemma-3": { evalBatchSize: 1024 }
    })
    const first = store.getState().saveLoadConfigurationSettings()
    await waitForMicrotasks()

    const readSecond = createSettlementReader(
      store.getState().saveLoadConfigurationSettings()
    )
    await waitForMicrotasks()

    expect(readSecond()).toBe("fulfilled")
    expect(listSettingsWrites(host.commands)).toHaveLength(1)
    writes[0]?.resolve(null)
    await first
  })

  it("saves the latest edit after the active write, coalescing edits made meanwhile", async () => {
    const { host, writes } = startControlledSettingsHost()
    const store = createLoadConfigurationStore({
      "gemma-3": { evalBatchSize: 256 }
    })
    const save = store.getState().saveLoadConfigurationSettings()
    await waitForMicrotasks()
    updateLoadSettings(store, { "gemma-3": { evalBatchSize: 512 } })
    updateLoadSettings(store, {
      "gemma-3": { evalBatchSize: 1024, flashAttention: false }
    })

    writes[0]?.resolve(null)
    await waitForMicrotasks()
    const afterFirstWrite = store.getState().loadConfigurationSave
    writes[1]?.resolve(null)
    await save

    expect(listSettingsWrites(host.commands)).toEqual([
      buildSettingsWrite({ "gemma-3": { evalBatchSize: 256 } }),
      buildSettingsWrite({
        "gemma-3": { evalBatchSize: 1024, flashAttention: false }
      })
    ])
    expect(afterFirstWrite).toEqual({ status: "saving" })
    expect(store.getState().loadConfigurationSave).toEqual({ status: "saved" })
  })

  it("still saves an edit made during a write that fails", async () => {
    const { host, writes } = startControlledSettingsHost()
    const store = createLoadConfigurationStore({
      "gemma-3": { evalBatchSize: 256 }
    })
    const save = store.getState().saveLoadConfigurationSettings()
    await waitForMicrotasks()
    updateLoadSettings(store, {})

    writes[0]?.reject("Disk full")
    await waitForMicrotasks()
    writes[1]?.resolve(null)
    await save

    expect(listSettingsWrites(host.commands)).toEqual([
      buildSettingsWrite({ "gemma-3": { evalBatchSize: 256 } }),
      buildSettingsWrite({})
    ])
    expect(store.getState().loadConfigurationSave).toEqual({ status: "saved" })
  })

  it("does not write again for settings replaced by equal ones during a write", async () => {
    const { host, writes } = startControlledSettingsHost()
    const store = createLoadConfigurationStore({
      "gemma-3": { evalBatchSize: 256 },
      "qwen3-8b": { numExperts: 2 }
    })
    const save = store.getState().saveLoadConfigurationSettings()
    await waitForMicrotasks()
    updateLoadSettings(store, {
      "qwen3-8b": { numExperts: 2 },
      "gemma-3": { evalBatchSize: 256 }
    })

    writes[0]?.resolve(null)
    await save

    expect(listSettingsWrites(host.commands)).toHaveLength(1)
    expect(store.getState().loadConfigurationSave).toEqual({ status: "saved" })
  })
})
