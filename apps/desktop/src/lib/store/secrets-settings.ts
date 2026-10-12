import type { CheckWebSearchKeyApiResponse } from "@lys/protocol"
import type { TavilyApiKey } from "@lys/share"
import type { StoreApi } from "zustand"

import type { LysSettings, SecretsSettings } from "./settings"

/** Lifecycle of the latest key save or removal. */
export type SecretsSaveState =
  | { readonly status: "idle" }
  | { readonly status: "saving" }
  | { readonly status: "saved" }
  | {
      readonly status: "failed"
      /** Caller-safe reason, without the key or a native path. */
      readonly error: string
    }

/** Lifecycle of the latest key check. */
export type TavilyKeyCheckState =
  | { readonly status: "idle" }
  | { readonly status: "checking" }
  | {
      readonly status: "checked"
      /** What the backend answered. */
      readonly outcome: CheckWebSearchKeyApiResponse
    }
  | {
      readonly status: "failed"
      /** Caller-safe reason the check could not be asked. */
      readonly error: string
    }

/**
 * Outcome of one save request: `saved` once the file holds the key, `failed`
 * when the save failed, and `busy` when another save was still running, so
 * nothing was saved.
 */
export type SecretsSaveOutcome = "saved" | "failed" | "busy"

/** Secrets state and its commands. */
export type SecretsSettingsSlice = {
  /** Latest save outcome, retained across pane unmounts. */
  readonly secretsSave: SecretsSaveState
  /** Latest key check, retained across pane unmounts. */
  readonly tavilyKeyCheck: TavilyKeyCheckState
  /**
   * Saves a key, or removes the saved one with null.
   * @param apiKey - Key that passed the shared key schema, or null.
   * @returns `saved` after the settings file holds the new value and the
   * store does too, `failed` when the save failed, or `busy` without saving
   * while another save runs. It never rejects.
   * @remarks A save resets the key check, and a check still running when
   * the save starts can no longer publish its result.
   */
  readonly saveTavilyApiKey: (
    apiKey: TavilyApiKey | null
  ) => Promise<SecretsSaveOutcome>
  /**
   * Asks the backend to check the saved key with Tavily.
   * @returns Resolves after the outcome is committed; it never rejects. A
   * call while a check runs does nothing.
   */
  readonly checkTavilyApiKey: () => Promise<void>
}

/** Narrow application state borrowed by the secrets slice. */
type SecretsSettingsStore = SecretsSettingsSlice & {
  /** Current settings owned by the application store. */
  readonly settings: LysSettings
}

/** Capabilities the secrets slice uses. */
export type SecretsSettingsDependencies = {
  /** Saves the secrets group, serialized with the other group saves. */
  readonly saveSecretsSettings: (secrets: SecretsSettings) => Promise<void>
  /** Asks the backend to check the saved key; rejects on transport failure. */
  readonly checkWebSearchKey: () => Promise<CheckWebSearchKeyApiResponse>
}

/** Save state before any save. */
const IDLE_SAVE: SecretsSaveState = Object.freeze({ status: "idle" })

/** Save state while a save runs. */
const SAVING: SecretsSaveState = Object.freeze({ status: "saving" })

/** Save state after a save. */
const SAVED: SecretsSaveState = Object.freeze({ status: "saved" })

/** Save state after a failed save. */
const SAVE_FAILED: SecretsSaveState = Object.freeze({
  status: "failed",
  error: "Lys couldn't write the key to its settings file."
})

/** Check state before any check, or after a save. */
const IDLE_CHECK: TavilyKeyCheckState = Object.freeze({ status: "idle" })

/** Check state while a check runs. */
const CHECKING: TavilyKeyCheckState = Object.freeze({ status: "checking" })

/** Check state when the backend could not be asked. */
const CHECK_FAILED: TavilyKeyCheckState = Object.freeze({
  status: "failed",
  error: "Lys couldn't reach its backend to check the key."
})

/**
 * Creates the application-owned secrets commands and initial state.
 * @param set - Owning store's atomic state updater.
 * @param get - Reads the current settings and the slice's state.
 * @param dependencies - Group save and key check capabilities.
 * @returns The slice.
 * @remarks The slice owns the key check's operation number: every check and
 * every save advances it, and a check publishes only while its number is
 * current, so a late result never replaces a newer state. Native writes are
 * not cancellable; leaving the pane cancels nothing.
 */
export function createSecretsSettingsSlice(
  set: StoreApi<SecretsSettingsStore>["setState"],
  get: StoreApi<SecretsSettingsStore>["getState"],
  dependencies: SecretsSettingsDependencies
): SecretsSettingsSlice {
  let currentKeyCheckOperation = 0

  /**
   * Implements {@link SecretsSettingsSlice.saveTavilyApiKey}.
   * @param apiKey - Key, or null to remove.
   * @returns The save outcome.
   */
  async function saveTavilyApiKey(
    apiKey: TavilyApiKey | null
  ): Promise<SecretsSaveOutcome> {
    if (get().secretsSave.status === "saving") return "busy"
    currentKeyCheckOperation += 1
    const secrets: SecretsSettings = Object.freeze({ tavilyApiKey: apiKey })
    set({ secretsSave: SAVING, tavilyKeyCheck: IDLE_CHECK })
    try {
      await dependencies.saveSecretsSettings(secrets)
    } catch {
      set({ secretsSave: SAVE_FAILED })
      return "failed"
    }
    set((state) => ({
      settings: { ...state.settings, secrets },
      secretsSave: SAVED
    }))
    return "saved"
  }

  /** Implements {@link SecretsSettingsSlice.checkTavilyApiKey}. */
  async function checkTavilyApiKey(): Promise<void> {
    if (get().tavilyKeyCheck.status === "checking") return
    currentKeyCheckOperation += 1
    const operation = currentKeyCheckOperation
    set({ tavilyKeyCheck: CHECKING })
    try {
      const outcome = await dependencies.checkWebSearchKey()
      if (operation !== currentKeyCheckOperation) return
      set({ tavilyKeyCheck: Object.freeze({ status: "checked", outcome }) })
    } catch {
      if (operation !== currentKeyCheckOperation) return
      set({ tavilyKeyCheck: CHECK_FAILED })
    }
  }

  return {
    secretsSave: IDLE_SAVE,
    tavilyKeyCheck: IDLE_CHECK,
    saveTavilyApiKey,
    checkTavilyApiKey
  }
}
