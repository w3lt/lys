import type {
  CheckEmailAccountApiRequestBody,
  CheckEmailAccountApiResponse,
  EmailServerCheck
} from "@lys/protocol"
import type { EmailAccount, EmailPassword, EmailSettings } from "@lys/share"
import type { StoreApi } from "zustand"

import type { McpSettingsSaveOutcome } from "./mcp-settings"
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
 * password, `failed` when the email server could not be switched off or the
 * removal failed, so the account stays, and `busy` when another save or
 * removal was still running, so nothing was removed.
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
   * Switches the email server off while it is on, then removes the saved
   * account and its password together.
   * @param switchEmailServerOff - Saves the email server's switch as off
   * and has the running backend apply it; called only while the switch is
   * on, and expected never to reject.
   * @returns `saved` after the settings file holds neither and the store
   * does too; `failed` when the switch's save did not answer `saved`, such
   * as while another save of the MCP group runs, or when the removal
   * failed, in which case the account stays; or `busy` without switching or
   * removing while another save or removal runs. It never rejects.
   * @remarks The email server cannot run without an account, so it is
   * switched off before the account goes. The save state is `saving` from
   * the switch's save until the removal settled, so no other save or
   * removal starts meanwhile. A removal resets the check, so an outcome of
   * the removed account is no longer shown.
   */
  readonly deleteEmailAccount: (
    switchEmailServerOff: () => Promise<McpSettingsSaveOutcome>
  ) => Promise<EmailAccountRemovalOutcome>
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

/** Save state after a removal that kept the account, because the email server stayed on. */
const SWITCH_OFF_FAILED: EmailAccountSaveState = Object.freeze({
  status: "failed",
  error:
    "Lys couldn't switch the email server off, so the account wasn't removed."
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
 * Answers whether one server accepted the sign-in.
 *
 * @param check - Outcome of signing in to the server.
 * @returns True when the server accepted.
 */
function isServerAccepted(check: EmailServerCheck): boolean {
  switch (check.status) {
    case "accepted":
      return true
    case "failed":
      return false
    default: {
      const unhandledCheck: never = check
      return unhandledCheck
    }
  }
}

/**
 * Answers whether a check of an email account accepted the sign-in to both
 * of its servers.
 *
 * @param outcome - What the backend answered.
 * @returns True when the check ran and both servers accepted.
 */
export function isEmailAccountCheckAccepted(
  outcome: CheckEmailAccountApiResponse
): boolean {
  switch (outcome.status) {
    case "checked":
      return isServerAccepted(outcome.imap) && isServerAccepted(outcome.smtp)
    case "unavailable":
      return false
    default: {
      const unhandledOutcome: never = outcome
      return unhandledOutcome
    }
  }
}

/**
 * Answers whether a save or removal of the email account runs.
 *
 * @param save - Latest save or removal.
 * @returns True while it runs.
 */
export function isEmailAccountSaveRunning(
  save: EmailAccountSaveState
): boolean {
  switch (save.status) {
    case "saving":
      return true
    case "idle":
    case "saved":
    case "failed":
      return false
    default: {
      const unhandledSave: never = save
      return unhandledSave
    }
  }
}

/**
 * Answers whether a check of an email account runs.
 *
 * @param check - Latest check.
 * @returns True while it runs.
 */
export function isEmailAccountCheckRunning(
  check: EmailAccountCheckState
): boolean {
  switch (check.status) {
    case "checking":
      return true
    case "idle":
    case "checked":
    case "failed":
      return false
    default: {
      const unhandledCheck: never = check
      return unhandledCheck
    }
  }
}

/**
 * Answers whether a save of the email account saved it.
 *
 * @param outcome - Outcome of the save.
 * @returns True once the settings file holds the account and its password.
 */
export function isEmailAccountSaved(outcome: EmailAccountSaveOutcome): boolean {
  switch (outcome) {
    case "saved":
      return true
    case "refused":
    case "failed":
    case "busy":
      return false
    default: {
      const unhandledOutcome: never = outcome
      return unhandledOutcome
    }
  }
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
      isEmailAccountSaveRunning(emailAccountSave) ||
      isEmailAccountCheckRunning(emailAccountCheck)
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
    if (!isEmailAccountCheckAccepted(outcome)) return "refused"
    return await saveAccountWithPassword(account, password)
  }

  /**
   * Implements {@link EmailSettingsSlice.deleteEmailAccount}.
   * @param switchEmailServerOff - Saves the email server's switch as off.
   * @returns The removal outcome.
   */
  async function deleteEmailAccount(
    switchEmailServerOff: () => Promise<McpSettingsSaveOutcome>
  ): Promise<EmailAccountRemovalOutcome> {
    if (isBusy()) return "busy"
    set({ emailAccountCheck: IDLE_CHECK, emailAccountSave: SAVING })
    if (get().settings.mcp.builtIn.email.enabled) {
      const switchOutcome = await switchEmailServerOff()
      switch (switchOutcome) {
        case "saved":
          break
        case "failed":
        case "busy":
          set({ emailAccountSave: SWITCH_OFF_FAILED })
          return "failed"
        default: {
          const unhandledOutcome: never = switchOutcome
          return unhandledOutcome
        }
      }
    }
    return await saveAccountWithPassword(null, null)
  }

  return {
    emailAccountSave: IDLE_SAVE,
    emailAccountCheck: IDLE_CHECK,
    saveEmailAccount,
    deleteEmailAccount
  }
}
