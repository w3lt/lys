import { describe, expect, it } from "vitest"
import { createStore } from "zustand/vanilla"
import {
  createGenerationSettingsSlice,
  isGenerationSettingsEqual,
  type GenerationSettingsSlice
} from "@/lib/store/generation-settings"
import type { GenerationSettings, LysSettings } from "@/lib/store/settings"
import { startNativeHostFake } from "../../support/nativeHostFake"
import {
  createControlledPromise,
  createSettlementReader,
  waitForMicrotasks,
  type ControlledPromise
} from "../../support/settlement"

/** Settings document on disk; its runtime and model groups must survive saves. */
const DISK_SETTINGS: LysSettings = Object.freeze({
  runtime: Object.freeze({
    autoStartBackend: false,
    defaultModel: "qwen3-8b",
    backendAddress: "http://127.0.0.1:23456"
  }),
  model: Object.freeze({ contextSize: 4096 }),
  generation: Object.freeze({ temperature: 0.2, replyCeiling: 512 })
})

/** Store state the slice borrows: the current settings and the slice. */
type GenerationStore = GenerationSettingsSlice & { settings: LysSettings }

/**
 * Creates a store holding settings with the given generation controls.
 *
 * @param generation - Generation controls currently in memory.
 * @returns A store owning one generation settings slice.
 */
function createGenerationStore(generation: GenerationSettings) {
  return createStore<GenerationStore>()((set, get) => ({
    settings: { ...DISK_SETTINGS, generation },
    ...createGenerationSettingsSlice(set, get)
  }))
}

/**
 * Edits the generation controls in memory, as the application store does
 * before it asks the slice to save.
 *
 * @param store - Store under test.
 * @param generation - New generation controls.
 */
function updateGeneration(
  store: ReturnType<typeof createGenerationStore>,
  generation: GenerationSettings
): void {
  store.setState({ settings: { ...store.getState().settings, generation } })
}

/**
 * Starts a native host whose settings writes stay pending until the case
 * settles them, one controlled promise per write.
 *
 * @returns The host observation handle and the pending writes in order.
 */
function startControlledSettingsHost() {
  const writes: ControlledPromise<null>[] = []
  const host = startNativeHostFake({
    load_settings: () => DISK_SETTINGS,
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
 * Builds the arguments of a write that replaces only the generation group of
 * the document on disk.
 *
 * @param generation - Generation controls the write must carry.
 * @returns The expected `save_settings` arguments.
 */
function buildSettingsWrite(generation: GenerationSettings) {
  return { newSettings: { ...DISK_SETTINGS, generation } }
}

describe("isGenerationSettingsEqual", () => {
  it("compares controls by value", () => {
    expect(
      isGenerationSettingsEqual(
        { temperature: 0.5, replyCeiling: 100 },
        { temperature: 0.5, replyCeiling: 100 }
      )
    ).toBe(true)
  })

  it.each([
    [{ temperature: 0.6, replyCeiling: 100 }],
    [{ temperature: 0.5, replyCeiling: 0 }]
  ])("reports %o as different", (other) => {
    expect(
      isGenerationSettingsEqual({ temperature: 0.5, replyCeiling: 100 }, other)
    ).toBe(false)
  })
})

describe("createGenerationSettingsSlice", () => {
  it("starts idle", () => {
    const store = createGenerationStore(DISK_SETTINGS.generation)

    expect(store.getState().generationSave).toEqual({ status: "idle" })
  })

  it("reports saving until the write completes, then saved, keeping the other groups on disk", async () => {
    const { host, writes } = startControlledSettingsHost()
    const store = createGenerationStore({ temperature: 0.9, replyCeiling: 0 })

    const save = store.getState().saveGenerationSettings()
    await waitForMicrotasks()
    const duringWrite = store.getState().generationSave
    writes[0]?.resolve(null)
    await save

    expect(duringWrite).toEqual({ status: "saving" })
    expect(store.getState().generationSave).toEqual({ status: "saved" })
    expect(listSettingsWrites(host.commands)).toEqual([
      buildSettingsWrite({ temperature: 0.9, replyCeiling: 0 })
    ])
  })

  it("reports a failed write without its native detail and keeps the edit", async () => {
    startNativeHostFake({
      load_settings: () => DISK_SETTINGS,
      save_settings: () => Promise.reject("EACCES: /Users/secret/settings.json")
    })
    const store = createGenerationStore({ temperature: 0.9, replyCeiling: 0 })

    await store.getState().saveGenerationSettings()

    expect(store.getState().generationSave).toEqual({ status: "failed" })
    expect(store.getState().settings.generation).toEqual({
      temperature: 0.9,
      replyCeiling: 0
    })
  })

  it("saves again when retried after a failure", async () => {
    let attempt = 0
    const host = startNativeHostFake({
      load_settings: () => DISK_SETTINGS,
      save_settings: () => {
        attempt += 1
        return attempt === 1 ? Promise.reject("Disk full") : null
      }
    })
    const store = createGenerationStore({ temperature: 0.9, replyCeiling: 0 })
    await store.getState().saveGenerationSettings()

    await store.getState().saveGenerationSettings()

    expect(store.getState().generationSave).toEqual({ status: "saved" })
    expect(listSettingsWrites(host.commands)).toHaveLength(2)
  })

  it("lets a save requested during a write return at once without a second concurrent write", async () => {
    const { host, writes } = startControlledSettingsHost()
    const store = createGenerationStore({ temperature: 0.9, replyCeiling: 0 })
    const first = store.getState().saveGenerationSettings()
    await waitForMicrotasks()

    const readSecond = createSettlementReader(
      store.getState().saveGenerationSettings()
    )
    await waitForMicrotasks()

    expect(readSecond()).toBe("fulfilled")
    expect(listSettingsWrites(host.commands)).toHaveLength(1)
    writes[0]?.resolve(null)
    await first
  })

  it("saves the latest edit after the active write, coalescing edits made meanwhile", async () => {
    const { host, writes } = startControlledSettingsHost()
    const store = createGenerationStore({ temperature: 0.1, replyCeiling: 0 })
    const save = store.getState().saveGenerationSettings()
    await waitForMicrotasks()
    updateGeneration(store, { temperature: 0.2, replyCeiling: 0 })
    updateGeneration(store, { temperature: 0.3, replyCeiling: 64 })

    writes[0]?.resolve(null)
    await waitForMicrotasks()
    const afterFirstWrite = store.getState().generationSave
    writes[1]?.resolve(null)
    await save

    expect(listSettingsWrites(host.commands)).toEqual([
      buildSettingsWrite({ temperature: 0.1, replyCeiling: 0 }),
      buildSettingsWrite({ temperature: 0.3, replyCeiling: 64 })
    ])
    expect(afterFirstWrite).toEqual({ status: "saving" })
    expect(store.getState().generationSave).toEqual({ status: "saved" })
  })

  it("still saves an edit made during a write that fails", async () => {
    const { host, writes } = startControlledSettingsHost()
    const store = createGenerationStore({ temperature: 0.1, replyCeiling: 0 })
    const save = store.getState().saveGenerationSettings()
    await waitForMicrotasks()
    updateGeneration(store, { temperature: 0.4, replyCeiling: 0 })

    writes[0]?.reject("Disk full")
    await waitForMicrotasks()
    writes[1]?.resolve(null)
    await save

    expect(listSettingsWrites(host.commands)).toEqual([
      buildSettingsWrite({ temperature: 0.1, replyCeiling: 0 }),
      buildSettingsWrite({ temperature: 0.4, replyCeiling: 0 })
    ])
    expect(store.getState().generationSave).toEqual({ status: "saved" })
  })

  it("does not start a write while another is pending", async () => {
    const { host, writes } = startControlledSettingsHost()
    const store = createGenerationStore({ temperature: 0.1, replyCeiling: 0 })
    const save = store.getState().saveGenerationSettings()
    await waitForMicrotasks()
    updateGeneration(store, { temperature: 0.5, replyCeiling: 0 })
    void store.getState().saveGenerationSettings()
    await waitForMicrotasks()

    const writesBeforeFirstSettles = listSettingsWrites(host.commands)
    writes[0]?.resolve(null)
    await waitForMicrotasks()
    writes[1]?.resolve(null)
    await save

    expect(writesBeforeFirstSettles).toHaveLength(1)
  })
})
