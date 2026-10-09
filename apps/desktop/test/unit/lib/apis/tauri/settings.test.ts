import { describe, expect, it } from "vitest"
import {
  loadSettings,
  saveGenerationSettings,
  saveSettings
} from "@/lib/apis/tauri/settings"
import type { LysSettings } from "@/lib/store/settings"
import { startNativeHostFake } from "../../../support/nativeHostFake"
import {
  createControlledPromise,
  createSettlementReader,
  waitForMicrotasks
} from "../../../support/settlement"

/** Settings document stored on disk, distinct from every default. */
const STORED_SETTINGS: LysSettings = Object.freeze({
  runtime: Object.freeze({
    autoStartBackend: false,
    defaultModel: "qwen3-8b",
    backendAddress: "http://127.0.0.1:23456"
  }),
  model: Object.freeze({ contextSize: 4096 }),
  generation: Object.freeze({ temperature: 0.2, replyCeiling: 512 })
})

describe("loadSettings", () => {
  it("resolves to the document the host loaded", async () => {
    const host = startNativeHostFake({ load_settings: () => STORED_SETTINGS })

    await expect(loadSettings()).resolves.toEqual(STORED_SETTINGS)
    expect(host.commands.map((invoked) => invoked.command)).toEqual([
      "load_settings"
    ])
  })

  it("rejects with the host's rejection", async () => {
    startNativeHostFake({
      load_settings: () => Promise.reject("Failed to parse settings.json")
    })

    await expect(loadSettings()).rejects.toBe("Failed to parse settings.json")
  })
})

describe("saveSettings", () => {
  it("sends the complete document as the command's newSettings argument", async () => {
    const host = startNativeHostFake({ save_settings: () => null })

    await saveSettings(STORED_SETTINGS)

    expect(host.commands).toEqual([
      { command: "save_settings", args: { newSettings: STORED_SETTINGS } }
    ])
  })

  it("resolves only after the host finishes writing", async () => {
    const write = createControlledPromise<null>()
    startNativeHostFake({ save_settings: () => write.promise })

    const readSettlement = createSettlementReader(saveSettings(STORED_SETTINGS))
    await waitForMicrotasks()
    const beforeWrite = readSettlement()
    write.resolve(null)
    await waitForMicrotasks()

    expect([beforeWrite, readSettlement()]).toEqual(["pending", "fulfilled"])
  })

  it("rejects with the host's rejection", async () => {
    startNativeHostFake({
      save_settings: () => Promise.reject("Failed to write settings.json")
    })

    await expect(saveSettings(STORED_SETTINGS)).rejects.toBe(
      "Failed to write settings.json"
    )
  })
})

describe("saveGenerationSettings", () => {
  it("replaces only the generation group of the document on disk", async () => {
    const host = startNativeHostFake({
      load_settings: () => STORED_SETTINGS,
      save_settings: () => null
    })

    await saveGenerationSettings({ temperature: 0.9, replyCeiling: 0 })

    expect(host.commands).toEqual([
      { command: "load_settings", args: {} },
      {
        command: "save_settings",
        args: {
          newSettings: {
            ...STORED_SETTINGS,
            generation: { temperature: 0.9, replyCeiling: 0 }
          }
        }
      }
    ])
  })

  it("writes nothing when the document cannot be loaded", async () => {
    const host = startNativeHostFake({
      load_settings: () => Promise.reject("Failed to read settings.json"),
      save_settings: () => null
    })

    await expect(
      saveGenerationSettings({ temperature: 0.9, replyCeiling: 0 })
    ).rejects.toBe("Failed to read settings.json")
    expect(host.commands.map((invoked) => invoked.command)).toEqual([
      "load_settings"
    ])
  })

  it("rejects when the merged document cannot be written", async () => {
    startNativeHostFake({
      load_settings: () => STORED_SETTINGS,
      save_settings: () => Promise.reject("Disk full")
    })

    await expect(
      saveGenerationSettings({ temperature: 0.9, replyCeiling: 0 })
    ).rejects.toBe("Disk full")
  })
})
