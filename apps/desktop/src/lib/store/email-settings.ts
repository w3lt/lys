import type {
  CheckEmailAccountApiRequestBody,
  CheckEmailAccountApiResponse
} from "@lys/protocol"
import type { EmailAccount, EmailPassword, EmailSettings } from "@lys/share"
import type { StoreApi } from "zustand"

import type { LysSettings, SecretsSettings } from "./settings"

/** Lifecycle of the latest save or removal of the email account. */
export type EmailAccountSaveState =
  | { readonly status: "idle" }
  | { readonly status: "saving" }
  | { readonly status: "saved" }
  | {
      readonly status: "failed"
      /** Caller-safe reason, without the account, the password, or a native path. */
      readonly error: string
    }

/** Lifecycle of the latest check of an account, which every save starts with. */
export type EmailAccountCheckState =
  | { readonly status: "idle" }
  | { readonly status: "checking" }
  | {
      readonly status: "checked"
      /** What the backend answered. */
      readonly outcome: CheckEmailAccountApiResponse
    }
  | {
      readonly status: "failed"
      /** Caller-safe reason the check could not be asked. */
      readonly error: string
    }

/**
 * Outcome of one save request: `saved` once the file holds the account and
 * its password, `refused` when a server did not accept the sign-in or the
 * check could not be run, so nothing was saved, `failed` when the check
 * could not be asked or the save failed, and `busy` when another save or
 * removal was still running, so nothing was saved.
 */
export type EmailAccountSaveOutcome = "saved" | "refused" | "failed" | "busy"

/**
 * Outcome of one removal: `saved` once the file holds no account and no
 * password, `failed` when the removal failed, and `busy` when another save
 * or removal was still running, so nothing was removed.
 */
export type EmailAccountRemovalOutcome = "saved" | "failed" | "busy"

/** Email account state and its commands. */
export type EmailSettingsSlice = {
  /** Latest save or removal, retained across pane unmounts. */
  readonly emailAccountSave: EmailAccountSaveState
  /** Latest check, retained across pane unmounts. */
  readonly emailAccountCheck: EmailAccountCheckState
  /**
   * Signs in to the account's servers through the backend and, once both
   * accepted, saves the account and its password together.
   * @param account - Account that passed the shared account schema.
   * @param password - Password that passed the shared password schema.
   * @returns `saved` after the settings file holds the account and the
   * password and the store does too, `refused` when a server did not accept
   * the sign-in or the backend could not run the check, `failed` when the
   * backend could not be asked or the save failed, or `busy` without
   * checking or saving while another save or removal runs. It never rejects.
   * @remarks The check ends within about a minute; a store reset does not
   * cancel it. The account is saved only after an accepted check, so the
   * file never holds an account the email server could not sign in with at
   * that moment.
   */
  readonly saveEmailAccount: (
    account: EmailAccount,
    password: EmailPassword
  ) => Promise<EmailAccountSaveOutcome>
  /**
   * Removes the saved account and its password together.
   * @returns `saved` after the settings file holds neither and the store
   * does too, `failed` when the removal failed, or `busy` without removing
   * while another save or removal runs. It never rejects.
   * @remarks A removal resets the check, so an outcome of the removed
   * account is no longer shown.
   */
  readonly removeEmailAccount: () => Promise<EmailAccountRemovalOutcome>
}

/** Narrow application state borrowed by the email slice. */
type EmailSettingsStore = EmailSettingsSlice & {
  /** Current settings owned by the application store. */
  readonly settings: LysSettings
}

/** Capabilities the email slice uses. */
type EmailSettingsDependencies = {
  /**
   * Saves the account and its password in one write, serialized with the
   * other group saves; null removes both.
   */
  readonly saveEmailAccountSettings: (
    account: EmailAccount | null,
    password: EmailPassword | null
  ) => Promise<void>
  /** Asks the backend to check an account; rejects on transport failure. */
  readonly sendEmailAccountCheck: (
    body: CheckEmailAccountApiRequestBody
  ) => Promise<CheckEmailAccountApiResponse>
}

/** Save state before any save. */
const IDLE_SAVE: EmailAccountSaveState = Object.freeze({ status: "idle" })

/** Save state while a save or removal runs. */
const SAVING: EmailAccountSaveState = Object.freeze({ status: "saving" })

/** Save state after a save or removal. */
const SAVED: EmailAccountSaveState = Object.freeze({ status: "saved" })

/** Save state after a failed save or removal. */
const SAVE_FAILED: EmailAccountSaveState = Object.freeze({
  status: "failed",
  error: "Lys couldn't write the email account to its settings file."
})

/** Check state before any check, or after a removal. */
const IDLE_CHECK: EmailAccountCheckState = Object.freeze({ status: "idle" })

/** Check state while a check runs. */
const CHECKING: EmailAccountCheckState = Object.freeze({ status: "checking" })

/** Check state when the backend could not be asked. */
const CHECK_FAILED: EmailAccountCheckState = Object.freeze({
  status: "failed",
  error: "Lys couldn't reach its backend to check the account."
})

/**
 * Builds the settings that hold an account and its password, or neither.
 *
 * @param settings - Settings before the change.
 * @param account - Account the file now holds, or null after a removal.
 * @param password - Its password, or null after a removal.
 * @returns The settings with the `email` group and the email password
 * replaced, every other group and secret kept.
 */
function buildEmailAccountSettings(
  settings: LysSettings,
  account: EmailAccount | null,
  password: EmailPassword | null
): LysSettings {
  const secrets: SecretsSettings = Object.freeze({
    ...settings.secrets,
    emailPassword: password
  })
  const email: EmailSettings = Object.freeze({ account })
  return { ...settings, secrets, email }
}

/**
 * Answers whether a check accepted the sign-in to both servers.
 *
 * @param outcome - What the backend answered.
 * @returns True when the check ran and both servers accepted.
 */
function isAccountAccepted(outcome: CheckEmailAccountApiResponse): boolean {
  return (
    outcome.status === "checked" &&
    outcome.imap.status === "accepted" &&
    outcome.smtp.status === "accepted"
  )
}

/**
 * Creates the application-owned email account commands and initial state.
 * @param set - Owning store's atomic state updater.
 * @param get - Reads the current settings and the slice's state.
 * @param dependencies - Group save and account check capabilities.
 * @returns The slice.
 * @remarks A save runs its check and its write one after the other, and no
 * second save or removal starts meanwhile, so the outcome shown always
 * concerns the account the file holds or the one just tried. The store's
 * account changes only after the file holds it, because the backend reads
 * the file: the MCP pane never shows an account as saved that the email
 * server would not get. Native writes are not cancellable; leaving the pane
 * cancels nothing.
 */
export function createEmailSettingsSlice(
  set: StoreApi<EmailSettingsStore>["setState"],
  get: StoreApi<EmailSettingsStore>["getState"],
  dependencies: EmailSettingsDependencies
): EmailSettingsSlice {
  /**
   * Answers whether a save or removal, or the check of a save, runs now.
   *
   * @returns True while one does, so another must wait.
   */
  function isBusy(): boolean {
    const { emailAccountSave, emailAccountCheck } = get()
    return (
      emailAccountSave.status === "saving" ||
      emailAccountCheck.status === "checking"
    )
  }

  /**
   * Saves an account and its password, or removes both, and publishes the
   * outcome.
   *
   * @param account - Account to save, or null to remove the saved one.
   * @param password - Its password, or null to remove the saved one.
   * @returns `saved` once the file and the store hold the new value, or
   * `failed`.
   */
  async function saveAccountWithPassword(
    account: EmailAccount | null,
    password: EmailPassword | null
  ): Promise<"saved" | "failed"> {
    set({ emailAccountSave: SAVING })
    try {
      await dependencies.saveEmailAccountSettings(account, password)
    } catch {
      set({ emailAccountSave: SAVE_FAILED })
      return "failed"
    }
    set((state) => {
      const settings = buildEmailAccountSettings(
        state.settings,
        account,
        password
      )
      return { settings, emailAccountSave: SAVED }
    })
    return "saved"
  }

  /**
   * Implements {@link EmailSettingsSlice.saveEmailAccount}.
   * @param account - Account to check and save.
   * @param password - Its password.
   * @returns The save outcome.
   */
  async function saveEmailAccount(
    account: EmailAccount,
    password: EmailPassword
  ): Promise<EmailAccountSaveOutcome> {
    if (isBusy()) return "busy"
    set({ emailAccountCheck: CHECKING, emailAccountSave: IDLE_SAVE })
    let outcome: CheckEmailAccountApiResponse
    try {
      outcome = await dependencies.sendEmailAccountCheck({ account, password })
    } catch {
      set({ emailAccountCheck: CHECK_FAILED })
      return "failed"
    }
    const checked: EmailAccountCheckState = Object.freeze({
      status: "checked",
      outcome
    })
    set({ emailAccountCheck: checked })
    if (!isAccountAccepted(outcome)) return "refused"
    return await saveAccountWithPassword(account, password)
  }

  /** Implements {@link EmailSettingsSlice.removeEmailAccount}. */
  async function removeEmailAccount(): Promise<EmailAccountRemovalOutcome> {
    if (isBusy()) return "busy"
    set({ emailAccountCheck: IDLE_CHECK })
    return await saveAccountWithPassword(null, null)
  }

  return {
    emailAccountSave: IDLE_SAVE,
    emailAccountCheck: IDLE_CHECK,
    saveEmailAccount,
    removeEmailAccount
  }
}
