import { describe, expect, it } from "vitest"
import {
  createSettingsGroupSaves,
  saveLatestSettingsGroup,
  type LatestSettingsGroupSave
} from "@/lib/store/settings-group-saves"
import type {
  LoadConfigurationSettings,
  RuntimeSettings
} from "@/lib/store/settings"
import { startNativeHostFake } from "../../support/nativeHostFake"
import {
  createControlledPromise,
  createSettlementReader,
  waitForMicrotasks,
  type ControlledPromise
} from "../../support/settlement"
import {
  STORED_SETTINGS_DOCUMENT,
  type SettingsDocument
} from "../../support/settingsFixtures"

/** Generation controls the group-save cases write. */
const EDITED_GENERATION = Object.freeze({ temperature: 0.9, replyCeiling: 0 })

/** Load settings the group-save cases write: one model with its own. */
const EDITED_LOAD_CONFIGURATION: LoadConfigurationSettings = Object.freeze({
  default: Object.freeze({}),
  models: new Map([["gemma-3", { evalBatchSize: 1024 }]])
})

/**
 * Answers whether a `save_settings` argument object carries a document.
 *
 * @param args - Arguments the renderer invoked the command with.
 * @returns Whether `newSettings` is present.
 */
function isSettingsWrite(args: unknown): args is { newSettings: unknown } {
  return typeof args === "object" && args !== null && "newSettings" in args
}

/**
 * Starts a native host that keeps one settings document as the settings file
 * does: `load_settings` returns the document last written, and each
 * `save_settings` stays pending until the case settles it and replaces the
 * document only when it is fulfilled.
 *
 * @returns The host observation handle, the pending writes in order, and a
 * reader of the document the file holds.
 */
function startSettingsFileHost() {
  let storedDocument: unknown = STORED_SETTINGS_DOCUMENT
  const writes: ControlledPromise<null>[] = []

  /**
   * Handles one `save_settings` command as the settings file does.
   *
   * @param args - Arguments the renderer invoked the command with.
   * @returns A promise that resolves with the command's `null` result once
   * the case fulfills the write, after the document is replaced. It rejects
   * with the case's reason when the case rejects the write, which leaves the
   * document as it was.
   * @throws A string, as a Rust `Err`, when the arguments carry no
   * `newSettings`; no write is then added.
   */
  async function handleSaveSettingsCommand(args: unknown): Promise<null> {
    if (!isSettingsWrite(args)) throw "save_settings needs newSettings"
    const write = createControlledPromise<null>()
    writes.push(write)
    await write.promise
    storedDocument = args.newSettings
    return null
  }

  const host = startNativeHostFake({
    load_settings: () => storedDocument,
    save_settings: handleSaveSettingsCommand
  })
  return { host, writes, readStoredDocument: () => storedDocument }
}

/**
 * Lists the names of the native commands a host observed.
 *
 * @param commands - Observed commands.
 * @returns The command names in invocation order.
 */
function listCommandNames(commands: readonly { command: string }[]): string[] {
  return commands.map((invoked) => invoked.command)
}

describe("createSettingsGroupSaves", () => {
  it("applies saves of different groups one at a time in the order sent, so neither loses the other's group", async () => {
    const { host, writes, readStoredDocument } = startSettingsFileHost()
    const saves = createSettingsGroupSaves()

    const generationSave = saves.saveGenerationSettings(EDITED_GENERATION)
    const loadSave = saves.saveLoadConfigurationSettings(
      EDITED_LOAD_CONFIGURATION
    )
    await waitForMicrotasks()
    const commandsDuringFirstWrite = listCommandNames(host.commands)
    writes[0]?.resolve(null)
    await generationSave
    await waitForMicrotasks()
    writes[1]?.resolve(null)
    await loadSave

    expect(commandsDuringFirstWrite).toEqual(["load_settings", "save_settings"])
    expect(listCommandNames(host.commands)).toEqual([
      "load_settings",
      "save_settings",
      "load_settings",
      "save_settings"
    ])
    expect(readStoredDocument()).toEqual({
      ...STORED_SETTINGS_DOCUMENT,
      generation: EDITED_GENERATION,
      loadConfiguration: {
        default: STORED_SETTINGS_DOCUMENT.loadConfiguration.default,
        models: { "gemma-3": { evalBatchSize: 1024 } }
      }
    })
  })

  it("applies a secrets save after a generation save sent before it, keeping both groups", async () => {
    const { writes, readStoredDocument } = startSettingsFileHost()
    const saves = createSettingsGroupSaves()

    const generationSave = saves.saveGenerationSettings(EDITED_GENERATION)
    const secretsSave = saves.saveSecretsSettings({ tavilyApiKey: null })
    await waitForMicrotasks()
    const writesDuringFirst = writes.length
    writes[0]?.resolve(null)
    await generationSave
    await waitForMicrotasks()
    writes[1]?.resolve(null)
    await secretsSave

    expect(writesDuringFirst).toBe(1)
    expect(readStoredDocument()).toEqual({
      ...STORED_SETTINGS_DOCUMENT,
      generation: EDITED_GENERATION,
      secrets: { tavilyApiKey: null }
    })
  })

  it("applies a tools save after a secrets save sent before it, keeping both groups", async () => {
    const { writes, readStoredDocument } = startSettingsFileHost()
    const saves = createSettingsGroupSaves()

    const secretsSave = saves.saveSecretsSettings({ tavilyApiKey: null })
    const toolsSave = saves.saveToolSettings({
      justRunToolNames: new Set(["find_files"]),
      switches: new Map([["web_search", true]])
    })
    await waitForMicrotasks()
    const writesDuringFirst = writes.length
    writes[0]?.resolve(null)
    await secretsSave
    await waitForMicrotasks()
    writes[1]?.resolve(null)
    await toolsSave

    expect(writesDuringFirst).toBe(1)
    expect(readStoredDocument()).toEqual({
      ...STORED_SETTINGS_DOCUMENT,
      secrets: { tavilyApiKey: null },
      tools: { justRun: ["find_files"], switches: { web_search: true } }
    })
  })

  it("applies a location save after a secrets save sent before it, keeping both groups", async () => {
    const { writes, readStoredDocument } = startSettingsFileHost()
    const saves = createSettingsGroupSaves()
    const noLocation = { city: null, region: null, country: null }

    const secretsSave = saves.saveSecretsSettings({ tavilyApiKey: null })
    const locationSave = saves.saveLocationSettings(noLocation)
    await waitForMicrotasks()
    const writesDuringFirst = writes.length
    writes[0]?.resolve(null)
    await secretsSave
    await waitForMicrotasks()
    writes[1]?.resolve(null)
    await locationSave

    expect(writesDuringFirst).toBe(1)
    expect(readStoredDocument()).toEqual({
      ...STORED_SETTINGS_DOCUMENT,
      secrets: { tavilyApiKey: null },
      location: noLocation
    })
  })

  it("applies an MCP save after a location save sent before it, keeping both groups", async () => {
    const { writes, readStoredDocument } = startSettingsFileHost()
    const saves = createSettingsGroupSaves()
    const noLocation = { city: null, region: null, country: null }

    const locationSave = saves.saveLocationSettings(noLocation)
    const mcpSave = saves.saveMcpSettings({ servers: [] })
    await waitForMicrotasks()
    const writesDuringFirst = writes.length
    writes[0]?.resolve(null)
    await locationSave
    await waitForMicrotasks()
    writes[1]?.resolve(null)
    await mcpSave

    expect(writesDuringFirst).toBe(1)
    expect(readStoredDocument()).toEqual({
      ...STORED_SETTINGS_DOCUMENT,
      location: noLocation,
      mcp: { servers: [] }
    })
  })

  it("applies a runtime startup save after a tools save sent before it, keeping both groups", async () => {
    const { writes, readStoredDocument } = startSettingsFileHost()
    const saves = createSettingsGroupSaves()

    const toolsSave = saves.saveToolSettings({
      justRunToolNames: new Set(["find_files"]),
      switches: new Map()
    })
    const runtimeSave = saves.saveRuntimeAutoStartSettings({
      autoStartBackend: true,
      autoStartVmo: true
    })
    await waitForMicrotasks()
    const writesDuringFirst = writes.length
    writes[0]?.resolve(null)
    await toolsSave
    await waitForMicrotasks()
    writes[1]?.resolve(null)
    await runtimeSave

    const runtime: RuntimeSettings = {
      ...STORED_SETTINGS_DOCUMENT.runtime,
      autoStartBackend: true,
      autoStartVmo: true
    }
    const tools: SettingsDocument["tools"] = {
      justRun: ["find_files"],
      switches: {}
    }
    expect(writesDuringFirst).toBe(1)
    expect(readStoredDocument()).toEqual({
      ...STORED_SETTINGS_DOCUMENT,
      runtime,
      tools
    })
  })

  it("rejects only the caller of a save that failed and still runs the saves sent after it", async () => {
    const { writes, readStoredDocument } = startSettingsFileHost()
    const saves = createSettingsGroupSaves()

    const generationSave = saves.saveGenerationSettings(EDITED_GENERATION)
    const loadSave = saves.saveLoadConfigurationSettings(
      EDITED_LOAD_CONFIGURATION
    )
    await waitForMicrotasks()
    writes[0]?.reject("Disk full")
    await expect(generationSave).rejects.toBe("Disk full")
    await waitForMicrotasks()
    writes[1]?.resolve(null)

    await expect(loadSave).resolves.toBeUndefined()
    expect(readStoredDocument()).toEqual({
      ...STORED_SETTINGS_DOCUMENT,
      loadConfiguration: {
        default: STORED_SETTINGS_DOCUMENT.loadConfiguration.default,
        models: { "gemma-3": { evalBatchSize: 1024 } }
      }
    })
  })
})

/** Settings group of the latest-value cases: one count, compared by value. */
type CountGroup = Readonly<{ count: number }>

/**
 * Creates a settings group whose saves stay pending until the case settles
 * them.
 *
 * @param initialCount - Count the group holds at first.
 * @returns The group as {@link saveLatestSettingsGroup} takes it, a function
 * that changes the current count, and the saves started so far, each with the
 * value it was given. Every read returns a new object, so only a comparison
 * by value finds two reads equal.
 */
function createControlledCountGroup(initialCount: number) {
  let currentCount = initialCount
  const saves: {
    readonly group: CountGroup
    readonly settlement: ControlledPromise<void>
  }[] = []
  const group: LatestSettingsGroupSave<CountGroup> = {
    getCurrent: () => ({ count: currentCount }),
    isEqual: (first, second) => first.count === second.count,
    save: (saved) => {
      const settlement = createControlledPromise<void>()
      saves.push({ group: saved, settlement })
      return settlement.promise
    }
  }
  return {
    group,
    saves,
    updateCount: (count: number) => {
      currentCount = count
    }
  }
}

describe("saveLatestSettingsGroup", () => {
  it("reports saved once the current value's save completes, without saving it again", async () => {
    const { group, saves } = createControlledCountGroup(1)

    const outcome = saveLatestSettingsGroup(group)
    saves[0]?.settlement.resolve()

    await expect(outcome).resolves.toBe("saved")
    expect(saves.map((save) => save.group)).toEqual([{ count: 1 }])
  })

  it("reports failed once the current value's save fails, without trying again", async () => {
    const { group, saves } = createControlledCountGroup(1)

    const outcome = saveLatestSettingsGroup(group)
    saves[0]?.settlement.reject("Disk full")

    await expect(outcome).resolves.toBe("failed")
    expect(saves).toHaveLength(1)
  })

  it("stays pending and saves the newer value when the value changed during a save that completed", async () => {
    const { group, saves, updateCount } = createControlledCountGroup(1)
    const outcome = saveLatestSettingsGroup(group)
    const readOutcome = createSettlementReader(outcome)

    updateCount(2)
    saves[0]?.settlement.resolve()
    await waitForMicrotasks()
    const afterFirstSave = readOutcome()
    saves[1]?.settlement.resolve()

    await expect(outcome).resolves.toBe("saved")
    expect(afterFirstSave).toBe("pending")
    expect(saves.map((save) => save.group)).toEqual([
      { count: 1 },
      { count: 2 }
    ])
  })

  it("saves the newer value when the value changed during a save that failed", async () => {
    const { group, saves, updateCount } = createControlledCountGroup(1)
    const outcome = saveLatestSettingsGroup(group)

    updateCount(2)
    saves[0]?.settlement.reject("Disk full")
    await waitForMicrotasks()
    saves[1]?.settlement.resolve()

    await expect(outcome).resolves.toBe("saved")
    expect(saves.map((save) => save.group)).toEqual([
      { count: 1 },
      { count: 2 }
    ])
  })

  it("reports failed when the newer value's save fails", async () => {
    const { group, saves, updateCount } = createControlledCountGroup(1)
    const outcome = saveLatestSettingsGroup(group)

    updateCount(2)
    saves[0]?.settlement.resolve()
    await waitForMicrotasks()
    saves[1]?.settlement.reject("Disk full")

    await expect(outcome).resolves.toBe("failed")
  })
})
