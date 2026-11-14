import {
  LLM_PROVIDERS,
  type GroqApiKey,
  type LlmProvider,
  type OllamaApiKey
} from "@lys/share"
import type { StoreApi } from "zustand"

import type {
  LysSettings,
  ProvidersSettings,
  SecretsSettings
} from "./settings"

/**
 * Lifecycle of the latest provider settings save, and while it runs or after
 * it failed, the provider it was for.
 */
export type ProviderSettingsSaveState =
  | { readonly status: "idle" }
  | {
      readonly status: "saving"
      /** Provider whose card asked for the save. */
      readonly provider: LlmProvider
    }
  | { readonly status: "saved" }
  | {
      readonly status: "failed"
      /** Provider whose card asked for the save. */
      readonly provider: LlmProvider
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
      /** Ollama Cloud. */
      readonly provider: "ollamaCloud"
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
   * Saves which providers are on and their addresses, then asks the backend
   * to connect again to every provider the save changed: turned on or off,
   * or given another address. The backend answers `off` for a provider
   * turned off.
   * @param provider - Provider whose card asks for the save: the one turned
   * on or off, or given another address. The save's state names it, so only
   * that card reports the save.
   * @param providers - Providers that are on and addresses to save.
   * @returns `saved` after the settings file and the store hold the group
   * and the reconnections settled, `failed` when the save failed, or `busy`
   * without saving while another provider save runs. It never rejects.
   */
  readonly saveProviderSettings: (
    provider: LlmProvider,
    providers: ProvidersSettings
  ) => Promise<ProviderSettingsSaveOutcome>
  /**
   * Saves a provider's key, or removes it with null, then asks the backend
   * to connect to that provider again while it is on.
   * @param change - Provider and key; the save's state names the provider.
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
   * Asks the backend to connect to one provider again; never rejects, and
   * does nothing while the backend is not running.
   *
   * @param provider - Provider to connect.
   */
  readonly connectLlmProvider: (provider: LlmProvider) => Promise<void>
}

/** Save state before any save. */
const IDLE_SAVE: ProviderSettingsSaveState = Object.freeze({ status: "idle" })

/** Save state after a save. */
const SAVED: ProviderSettingsSaveState = Object.freeze({ status: "saved" })

/** Caller-safe reason of a failed save. */
const SAVE_FAILED_ERROR =
  "Lys couldn't write the provider to its settings file."

/**
 * Answers whether a provider sends its key, so a change of that key changes
 * how the backend connects.
 * @param providers - Saved providers group.
 * @param provider - Provider whose key changed.
 * @returns True while that provider is on.
 */
function isKeyInUse(
  providers: ProvidersSettings,
  provider: ProviderApiKeyChange["provider"]
): boolean {
  return providers.enabled.includes(provider)
}

/**
 * Answers whether a providers save changes how the backend reaches one
 * provider.
 * @param previous - Group held before the save.
 * @param saved - Group the save wrote.
 * @param provider - Provider to check.
 * @returns True when the save turned the provider on or off, or gave it
 * another address while it stays on.
 */
function hasProviderChanged(
  previous: ProvidersSettings,
  saved: ProvidersSettings,
  provider: LlmProvider
): boolean {
  const isOn = saved.enabled.includes(provider)
  if (previous.enabled.includes(provider) !== isOn) return true
  if (!isOn) return false
  switch (provider) {
    case "lmStudio":
      return previous.lmStudio.address !== saved.lmStudio.address
    case "ollama":
      return previous.ollama.address !== saved.ollama.address
    case "ollamaCloud":
    case "groq":
      return false
  }
}

/**
 * Builds the secrets change that saves one provider key.
 * @param change - Provider and key.
 * @returns The secrets group field of that provider's key.
 */
function buildSecretsChange(
  change: ProviderApiKeyChange
): Partial<SecretsSettings> {
  return change.provider === "ollamaCloud"
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
 * answers `busy`. A running or failed save names the provider it is for, so
 * the pane reports it on that provider's card only. The store's settings
 * change only after the file holds the
 * change, so the pane never shows a group the backend cannot read. The
 * backend reads the providers group and the keys at each connection
 * attempt, so the slice reconnects each provider a save changes, all at
 * once. Native writes are not cancellable; leaving the pane cancels nothing.
 */
export function createProviderSettingsSlice(
  set: StoreApi<ProviderSettingsStore>["setState"],
  get: StoreApi<ProviderSettingsStore>["getState"],
  dependencies: ProviderSettingsDependencies
): ProviderSettingsSlice {
  /**
   * Runs one save, publishing its state, unless another save runs.
   * @param provider - Provider the save is for, which its state names.
   * @param save - Writes the change to the settings file.
   * @param applySaved - Applies the saved change to the store's settings.
   * @returns The save outcome.
   */
  async function runProviderSave(
    provider: LlmProvider,
    save: () => Promise<void>,
    applySaved: (settings: LysSettings) => LysSettings
  ): Promise<ProviderSettingsSaveOutcome> {
    if (get().providerSettingsSave.status === "saving") return "busy"
    set({ providerSettingsSave: Object.freeze({ status: "saving", provider }) })
    try {
      await save()
    } catch {
      set({
        providerSettingsSave: Object.freeze({
          status: "failed",
          provider,
          error: SAVE_FAILED_ERROR
        })
      })
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
    provider: LlmProvider,
    providers: ProvidersSettings
  ): Promise<ProviderSettingsSaveOutcome> {
    const previous = get().settings.providers
    const outcome = await runProviderSave(
      provider,
      () => dependencies.saveProviderSettings(providers),
      (settings) => ({ ...settings, providers })
    )
    if (outcome === "saved") {
      await Promise.all(
        LLM_PROVIDERS.filter((changed) =>
          hasProviderChanged(previous, providers, changed)
        ).map((changed) => dependencies.connectLlmProvider(changed))
      )
    }
    return outcome
  }

  /** Implements {@link ProviderSettingsSlice.saveProviderApiKey}. */
  async function saveProviderApiKey(
    change: ProviderApiKeyChange
  ): Promise<ProviderSettingsSaveOutcome> {
    const secretsChange = buildSecretsChange(change)
    const outcome = await runProviderSave(
      change.provider,
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
      await dependencies.connectLlmProvider(change.provider)
    }
    return outcome
  }

  return {
    providerSettingsSave: IDLE_SAVE,
    saveProviderSettings,
    saveProviderApiKey
  }
}
