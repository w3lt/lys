import {
  groqApiKeySchema,
  llmProviderSettingsSchema,
  ollamaApiKeySchema
} from "@lys/share"
import { describe, expect, it, vi } from "vitest"
import { createStore } from "zustand/vanilla"
import {
  createProviderSettingsSlice,
  type ProviderSettingsSlice
} from "@/lib/store/provider-settings"
import type { LysSettings } from "@/lib/store/settings"
import { createSettingsGroupSaves } from "@/lib/store/settings-group-saves"
import { startNativeHostFake } from "../../support/nativeHostFake"
import {
  createControlledPromise,
  waitForMicrotasks,
  type ControlledPromise
} from "../../support/settlement"
import {
  STORED_PROVIDERS_SETTINGS,
  STORED_SETTINGS,
  STORED_SETTINGS_DOCUMENT
} from "../../support/settingsFixtures"

/** Store state the slice borrows: the current settings and the slice. */
type ProviderStore = ProviderSettingsSlice & { settings: LysSettings }

/** Groq active, the choice a case switches to. */
const GROQ_ACTIVE = llmProviderSettingsSchema.parse({
  ...STORED_PROVIDERS_SETTINGS,
  active: "groq"
})

/** Ollama active in cloud mode. */
const OLLAMA_CLOUD_ACTIVE = llmProviderSettingsSchema.parse({
  ...STORED_PROVIDERS_SETTINGS,
  ollama: { ...STORED_PROVIDERS_SETTINGS.ollama, mode: "cloud" }
})

/** Ollama key a case saves: a made-up value of a key's shape. */
const NEW_OLLAMA_API_KEY = ollamaApiKeySchema.parse("ollama-fixture-1111111")

/** Groq key a case saves: a made-up value of a key's shape. */
const NEW_GROQ_API_KEY = groqApiKeySchema.parse("gsk_fixture_1111111111111")

/**
 * Creates a store holding the stored settings with one provider settings
 * slice.
 *
 * @param settings - Settings the store starts with; the stored ones when
 * omitted.
 * @returns The store, whose saves run through the application's
 * settings-group saves over the native host, and the reconnection spy.
 */
function createProviderStore(settings: LysSettings = STORED_SETTINGS) {
  const settingsGroupSaves = createSettingsGroupSaves()
  const connectLlmProvider = vi.fn(async () => undefined)
  const store = createStore<ProviderStore>()((set, get) => ({
    settings,
    ...createProviderSettingsSlice(set, get, {
      saveProviderSettings: settingsGroupSaves.saveProviderSettings,
      saveSecretsSettings: settingsGroupSaves.saveSecretsSettings,
      connectLlmProvider
    })
  }))
  return { store, connectLlmProvider }
}

/**
 * Starts a native host that loads the stored settings document and whose
 * settings writes stay pending until the case settles them.
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
 * Lists the documents of every settings write, in order.
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

describe("createProviderSettingsSlice", () => {
  it("starts with no save", () => {
    const { store } = createProviderStore()

    expect(store.getState().providerSettingsSave).toEqual({ status: "idle" })
  })

  describe("saveProviderSettings", () => {
    it("saves the choice, holds it once written, then reconnects", async () => {
      const { host, writes } = startControlledSettingsHost()
      const { store, connectLlmProvider } = createProviderStore()

      const save = store.getState().saveProviderSettings(GROQ_ACTIVE)
      await waitForMicrotasks()
      const whileWriting = store.getState()
      writes[0]?.resolve(null)

      await expect(save).resolves.toBe("saved")
      expect(whileWriting.providerSettingsSave).toEqual({ status: "saving" })
      expect(whileWriting.settings.providers).toBe(STORED_PROVIDERS_SETTINGS)
      expect(store.getState().providerSettingsSave).toEqual({
        status: "saved"
      })
      expect(store.getState().settings.providers).toBe(GROQ_ACTIVE)
      expect(listSettingsWrites(host.commands)).toEqual([
        { newSettings: { ...STORED_SETTINGS_DOCUMENT, providers: GROQ_ACTIVE } }
      ])
      expect(connectLlmProvider).toHaveBeenCalledOnce()
    })

    it("keeps the choice and does not reconnect when the save fails", async () => {
      const { writes } = startControlledSettingsHost()
      const { store, connectLlmProvider } = createProviderStore()

      const save = store.getState().saveProviderSettings(GROQ_ACTIVE)
      await waitForMicrotasks()
      writes[0]?.reject("EACCES: /Users/someone/.lys/settings.json")

      await expect(save).resolves.toBe("failed")
      expect(store.getState().providerSettingsSave).toEqual({
        status: "failed",
        error: "Lys couldn't write the provider to its settings file."
      })
      expect(store.getState().settings.providers).toBe(
        STORED_PROVIDERS_SETTINGS
      )
      expect(connectLlmProvider).not.toHaveBeenCalled()
    })

    it("answers busy without writing while another save runs", async () => {
      const { host, writes } = startControlledSettingsHost()
      const { store } = createProviderStore()

      const first = store.getState().saveProviderSettings(GROQ_ACTIVE)
      await waitForMicrotasks()
      const second = await store
        .getState()
        .saveProviderApiKey({ provider: "groq", apiKey: NEW_GROQ_API_KEY })
      writes[0]?.resolve(null)
      await first

      expect(second).toBe("busy")
      expect(listSettingsWrites(host.commands)).toHaveLength(1)
    })
  })

  describe("saveProviderApiKey", () => {
    it("saves only that key, keeping the other keys, and reconnects while its provider uses it", async () => {
      const { host, writes } = startControlledSettingsHost()
      const { store, connectLlmProvider } = createProviderStore({
        ...STORED_SETTINGS,
        providers: GROQ_ACTIVE
      })

      const save = store
        .getState()
        .saveProviderApiKey({ provider: "groq", apiKey: NEW_GROQ_API_KEY })
      await waitForMicrotasks()
      writes[0]?.resolve(null)

      await expect(save).resolves.toBe("saved")
      expect(store.getState().settings.secrets).toEqual({
        ...STORED_SETTINGS.secrets,
        groqApiKey: NEW_GROQ_API_KEY
      })
      expect(listSettingsWrites(host.commands)).toEqual([
        {
          newSettings: {
            ...STORED_SETTINGS_DOCUMENT,
            secrets: {
              ...STORED_SETTINGS_DOCUMENT.secrets,
              groqApiKey: NEW_GROQ_API_KEY
            }
          }
        }
      ])
      expect(connectLlmProvider).toHaveBeenCalledOnce()
    })

    it("reconnects for Ollama's key only while Ollama runs in cloud mode", async () => {
      const { writes } = startControlledSettingsHost()
      const local = createProviderStore()
      const cloud = createProviderStore({
        ...STORED_SETTINGS,
        providers: OLLAMA_CLOUD_ACTIVE
      })

      const localSave = local.store
        .getState()
        .saveProviderApiKey({ provider: "ollama", apiKey: NEW_OLLAMA_API_KEY })
      await waitForMicrotasks()
      writes[0]?.resolve(null)
      await localSave
      const cloudSave = cloud.store
        .getState()
        .saveProviderApiKey({ provider: "ollama", apiKey: NEW_OLLAMA_API_KEY })
      await waitForMicrotasks()
      writes[1]?.resolve(null)
      await cloudSave

      expect(local.connectLlmProvider).not.toHaveBeenCalled()
      expect(cloud.connectLlmProvider).toHaveBeenCalledOnce()
    })

    it("removes a key with null without reconnecting while another provider is active", async () => {
      const { writes } = startControlledSettingsHost()
      const { store, connectLlmProvider } = createProviderStore()

      const removal = store
        .getState()
        .saveProviderApiKey({ provider: "groq", apiKey: null })
      await waitForMicrotasks()
      writes[0]?.resolve(null)

      await expect(removal).resolves.toBe("saved")
      expect(store.getState().settings.secrets.groqApiKey).toBeNull()
      expect(connectLlmProvider).not.toHaveBeenCalled()
    })
  })
})
