import type { GroqApiKey, OllamaApiKey } from "@lys/share"
import type { StoreApi } from "zustand"

import type {
  LysSettings,
  ProvidersSettings,
  SecretsSettings
} from "./settings"

/** Lifecycle of the latest provider settings save. */
export type ProviderSettingsSaveState =
  | { readonly status: "idle" }
  | { readonly status: "saving" }
  | { readonly status: "saved" }
  | {
      readonly status: "failed"
      /** Caller-safe reason, without a key or a native path. */
      readonly error: string
    }

/**
 * Outcome of one save request: `saved` once the file holds the change,
 * `failed` when the save failed, and `busy` when another provider save was
 * still running, so nothing was saved.
 */
export type ProviderSettingsSaveOutcome = "saved" | "failed" | "busy"

/** A provider key to save, or to remove with null. */
export type ProviderApiKeyChange =
  | {
      /** Ollama's cloud. */
      readonly provider: "ollama"
      /** Key that passed the shared Ollama key schema, or null. */
      readonly apiKey: OllamaApiKey | null
    }
  | {
      /** Groq. */
      readonly provider: "groq"
      /** Key that passed the shared Groq key schema, or null. */
      readonly apiKey: GroqApiKey | null
    }

/** Provider settings state and its commands. */
export type ProviderSettingsSlice = {
  /** Latest save outcome, retained across pane unmounts. */
  readonly providerSettingsSave: ProviderSettingsSaveState
  /**
   * Saves the provider choice and addresses, then asks the backend to
   * connect again, so the next request goes to the saved provider.
   * @param providers - Provider choice and addresses to save.
   * @returns `saved` after the settings file and the store hold the choice
   * and the reconnection settled, `failed` when the save failed, or `busy`
   * without saving while another provider save runs. It never rejects.
   */
  readonly saveProviderSettings: (
    providers: ProvidersSettings
  ) => Promise<ProviderSettingsSaveOutcome>
  /**
   * Saves a provider's key, or removes it with null, then asks the backend
   * to connect again when the active provider uses that key.
   * @param change - Provider and key.
   * @returns The same outcomes as {@link saveProviderSettings}. It never
   * rejects.
   */
  readonly saveProviderApiKey: (
    change: ProviderApiKeyChange
  ) => Promise<ProviderSettingsSaveOutcome>
}

/** Narrow application state borrowed by the provider settings slice. */
type ProviderSettingsStore = ProviderSettingsSlice & {
  /** Current settings owned by the application store. */
  readonly settings: LysSettings
}

/** Capabilities the provider settings slice uses. */
export type ProviderSettingsDependencies = {
  /** Saves the providers group, serialized with the other group saves. */
  readonly saveProviderSettings: (providers: ProvidersSettings) => Promise<void>
  /**
   * Saves some keys of the secrets group, serialized with the other group
   * saves; keys not given keep their values on disk.
   */
  readonly saveSecretsSettings: (
    changedSecrets: Partial<SecretsSettings>
  ) => Promise<void>
  /**
   * Asks the backend to connect to the saved provider again; never rejects,
   * and does nothing while the backend is not running.
   */
  readonly connectLlmProvider: () => Promise<void>
}

/** Save state before any save. */
const IDLE_SAVE: ProviderSettingsSaveState = Object.freeze({ status: "idle" })

/** Save state while a save runs. */
const SAVING: ProviderSettingsSaveState = Object.freeze({ status: "saving" })

/** Save state after a save. */
const SAVED: ProviderSettingsSaveState = Object.freeze({ status: "saved" })

/** Save state after a failed save. */
const SAVE_FAILED: ProviderSettingsSaveState = Object.freeze({
  status: "failed",
  error: "Lys couldn't write the provider to its settings file."
})

/**
 * Answers whether the active provider sends a key, so a change of that key
 * changes how the backend connects.
 * @param providers - Saved provider choice.
 * @param provider - Provider whose key changed.
 * @returns True for Groq while Groq is active, and for Ollama while Ollama
 * is active in cloud mode.
 */
function isKeyInUse(
  providers: ProvidersSettings,
  provider: ProviderApiKeyChange["provider"]
): boolean {
  if (providers.active !== provider) return false
  return provider === "groq" || providers.ollama.mode === "cloud"
}

/**
 * Builds the secrets change that saves one provider key.
 * @param change - Provider and key.
 * @returns The secrets group field of that provider's key.
 */
function buildSecretsChange(
  change: ProviderApiKeyChange
): Partial<SecretsSettings> {
  return change.provider === "ollama"
    ? { ollamaApiKey: change.apiKey }
    : { groqApiKey: change.apiKey }
}

/**
 * Creates the application-owned provider settings commands and initial state.
 * @param set - Owning store's atomic state updater.
 * @param get - Reads the current settings and the slice's state.
 * @param dependencies - Group saves and the reconnection.
 * @returns The slice.
 * @remarks One provider save runs at a time; a request while one runs
 * answers `busy`. The store's settings change only after the file holds the
 * change, so the pane never shows a choice the backend cannot read. The
 * backend reads the providers group and the keys at each connection
 * attempt, so the slice reconnects after a save that changes them. Native
 * writes are not cancellable; leaving the pane cancels nothing.
 */
export function createProviderSettingsSlice(
  set: StoreApi<ProviderSettingsStore>["setState"],
  get: StoreApi<ProviderSettingsStore>["getState"],
  dependencies: ProviderSettingsDependencies
): ProviderSettingsSlice {
  /**
   * Runs one save, publishing its state, unless another save runs.
   * @param save - Writes the change to the settings file.
   * @param applySaved - Applies the saved change to the store's settings.
   * @returns The save outcome.
   */
  async function runProviderSave(
    save: () => Promise<void>,
    applySaved: (settings: LysSettings) => LysSettings
  ): Promise<ProviderSettingsSaveOutcome> {
    if (get().providerSettingsSave.status === "saving") return "busy"
    set({ providerSettingsSave: SAVING })
    try {
      await save()
    } catch {
      set({ providerSettingsSave: SAVE_FAILED })
      return "failed"
    }
    set((state) => ({
      settings: applySaved(state.settings),
      providerSettingsSave: SAVED
    }))
    return "saved"
  }

  /** Implements {@link ProviderSettingsSlice.saveProviderSettings}. */
  async function saveProviderSettings(
    providers: ProvidersSettings
  ): Promise<ProviderSettingsSaveOutcome> {
    const outcome = await runProviderSave(
      () => dependencies.saveProviderSettings(providers),
      (settings) => ({ ...settings, providers })
    )
    if (outcome === "saved") await dependencies.connectLlmProvider()
    return outcome
  }

  /** Implements {@link ProviderSettingsSlice.saveProviderApiKey}. */
  async function saveProviderApiKey(
    change: ProviderApiKeyChange
  ): Promise<ProviderSettingsSaveOutcome> {
    const secretsChange = buildSecretsChange(change)
    const outcome = await runProviderSave(
      () => dependencies.saveSecretsSettings(secretsChange),
      (settings) => ({
        ...settings,
        secrets: Object.freeze({ ...settings.secrets, ...secretsChange })
      })
    )
    if (
      outcome === "saved" &&
      isKeyInUse(get().settings.providers, change.provider)
    ) {
      await dependencies.connectLlmProvider()
    }
    return outcome
  }

  return {
    providerSettingsSave: IDLE_SAVE,
    saveProviderSettings,
    saveProviderApiKey
  }
}
