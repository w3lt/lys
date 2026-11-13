import {
  groqApiKeySchema,
  llmProviderSettingsSchema,
  ollamaApiKeySchema,
  type LlmProvider
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

/** Groq turned on beside the stored local Ollama server. */
const GROQ_ADDED = llmProviderSettingsSchema.parse({
  ...STORED_PROVIDERS_SETTINGS,
  enabled: ["ollama", "groq"]
})

/** Only Ollama Cloud on. */
const OLLAMA_CLOUD_ONLY = llmProviderSettingsSchema.parse({
  ...STORED_PROVIDERS_SETTINGS,
  enabled: ["ollamaCloud"]
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
  const connectLlmProvider = vi.fn<(provider: LlmProvider) => Promise<void>>(
    async () => undefined
  )
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
    it("saves the providers, holds them once written, then connects the provider it turned on", async () => {
      const { host, writes } = startControlledSettingsHost()
      const { store, connectLlmProvider } = createProviderStore()

      const save = store.getState().saveProviderSettings(GROQ_ADDED)
      await waitForMicrotasks()
      const whileWriting = store.getState()
      writes[0]?.resolve(null)

      await expect(save).resolves.toBe("saved")
      expect(whileWriting.providerSettingsSave).toEqual({ status: "saving" })
      expect(whileWriting.settings.providers).toBe(STORED_PROVIDERS_SETTINGS)
      expect(store.getState().providerSettingsSave).toEqual({
        status: "saved"
      })
      expect(store.getState().settings.providers).toBe(GROQ_ADDED)
      expect(listSettingsWrites(host.commands)).toEqual([
        { newSettings: { ...STORED_SETTINGS_DOCUMENT, providers: GROQ_ADDED } }
      ])
      expect(connectLlmProvider.mock.calls).toEqual([["groq"]])
    })

    it("connects every provider it turned on or off, and none it left as it was", async () => {
      const { writes } = startControlledSettingsHost()
      const { store, connectLlmProvider } = createProviderStore()

      const save = store.getState().saveProviderSettings(OLLAMA_CLOUD_ONLY)
      await waitForMicrotasks()
      writes[0]?.resolve(null)
      await save

      expect(connectLlmProvider.mock.calls).toEqual([
        ["ollama"],
        ["ollamaCloud"]
      ])
    })

    it("connects a provider that stays on when its address changes", async () => {
      const { writes } = startControlledSettingsHost()
      const { store, connectLlmProvider } = createProviderStore()
      const moved = llmProviderSettingsSchema.parse({
        ...STORED_PROVIDERS_SETTINGS,
        ollama: { address: "192.168.1.21:11434" },
        lmStudio: { address: "192.168.1.5:1234" }
      })

      const save = store.getState().saveProviderSettings(moved)
      await waitForMicrotasks()
      writes[0]?.resolve(null)
      await save

      expect(connectLlmProvider.mock.calls).toEqual([["ollama"]])
    })

    it("keeps the providers and connects none when the save fails", async () => {
      const { writes } = startControlledSettingsHost()
      const { store, connectLlmProvider } = createProviderStore()

      const save = store.getState().saveProviderSettings(GROQ_ADDED)
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

      const first = store.getState().saveProviderSettings(GROQ_ADDED)
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
    it("saves only that key, keeping the other keys, and connects its provider while it is on", async () => {
      const { host, writes } = startControlledSettingsHost()
      const { store, connectLlmProvider } = createProviderStore({
        ...STORED_SETTINGS,
        providers: GROQ_ADDED
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
      expect(connectLlmProvider.mock.calls).toEqual([["groq"]])
    })

    it("connects Ollama Cloud for its key only while Ollama Cloud is on, not a local Ollama server", async () => {
      const { writes } = startControlledSettingsHost()
      const local = createProviderStore()
      const cloud = createProviderStore({
        ...STORED_SETTINGS,
        providers: OLLAMA_CLOUD_ONLY
      })

      const localSave = local.store.getState().saveProviderApiKey({
        provider: "ollamaCloud",
        apiKey: NEW_OLLAMA_API_KEY
      })
      await waitForMicrotasks()
      writes[0]?.resolve(null)
      await localSave
      const cloudSave = cloud.store.getState().saveProviderApiKey({
        provider: "ollamaCloud",
        apiKey: NEW_OLLAMA_API_KEY
      })
      await waitForMicrotasks()
      writes[1]?.resolve(null)
      await cloudSave

      expect(local.connectLlmProvider).not.toHaveBeenCalled()
      expect(cloud.connectLlmProvider.mock.calls).toEqual([["ollamaCloud"]])
    })

    it("removes a key with null without connecting while its provider is off", async () => {
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
