import type {
  CheckEmailAccountApiRequestBody,
  CheckEmailAccountApiResponse,
  EmailServerCheck
} from "@lys/protocol"
import type { EmailAccount, EmailPassword } from "@lys/share"
import type { StoreApi } from "zustand"

import {
  buildEmailMailboxAccountSettings,
  isEmailMailboxOn,
  type EmailMailbox,
  type EmailMailboxAccount
} from "@/lib/models/email-mailbox"

import type { McpSettingsSaveOutcome } from "./mcp-settings"
import type { LysSettings } from "./settings"

/** Lifecycle of the latest save or removal of one mailbox's account. */
export type EmailAccountSaveState =
  | { readonly status: "idle" }
  | { readonly status: "saving" }
  | { readonly status: "saved" }
  | {
      readonly status: "failed"
      /** Caller-safe reason, without the account, the password, or a native path. */
      readonly error: string
    }

/** One state of each mailbox's account. */
export type EmailMailboxStates<TState> = Readonly<Record<EmailMailbox, TState>>

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
 * password, `failed` when the mailbox could not be switched off or the
 * removal failed, so the account stays, and `busy` when another save or
 * removal was still running, so nothing was removed.
 */
export type EmailAccountRemovalOutcome = "saved" | "failed" | "busy"

/** Email account state of each mailbox and its commands. */
export type EmailSettingsSlice = {
  /** Latest save or removal of each mailbox, retained across pane unmounts. */
  readonly emailAccountSaves: EmailMailboxStates<EmailAccountSaveState>
  /** Latest check of each mailbox, retained across pane unmounts. */
  readonly emailAccountChecks: EmailMailboxStates<EmailAccountCheckState>
  /**
   * Signs in to the account's servers through the backend and, once both
   * accepted, saves it and its password together as one mailbox's.
   * @param mailbox - Whose account it is; only its account, password, save,
   * and check change.
   * @param account - Account that passed the shared account schema.
   * @param password - Password that passed the shared password schema.
   * @returns `saved` after the settings file holds the account and the
   * password and the store does too, `refused` when a server did not accept
   * the sign-in or the backend could not run the check, `failed` when the
   * backend could not be asked or the save failed, or `busy` without
   * checking or saving while another save or removal of the mailbox runs.
   * It never rejects.
   * @remarks The check ends within about a minute; a store reset does not
   * cancel it. The account is saved only after an accepted check, so the
   * file never holds an account the email server could not sign in with at
   * that moment. The two mailboxes save independently; a save that would
   * make them one mailbox is refused by the desktop host and fails.
   */
  readonly saveEmailAccount: (
    mailbox: EmailMailbox,
    account: EmailAccount,
    password: EmailPassword
  ) => Promise<EmailAccountSaveOutcome>
  /**
   * Switches the mailbox off while it is on, then removes its saved account
   * and its password together.
   * @param mailbox - Whose account to remove; only its account, password,
   * save, and check change.
   * @param saveMailboxSwitchOff - Saves the mailbox's switch as off and has
   * the running backend apply it; called only while the switch is on, and
   * expected never to reject.
   * @returns `saved` after the settings file holds neither and the store
   * does too; `failed` when the switch's save did not answer `saved`, such
   * as while another save of the MCP group runs, or when the removal
   * failed, in which case the account stays; or `busy` without switching or
   * removing while another save or removal of the mailbox runs. It never
   * rejects.
   * @remarks The email server cannot serve a mailbox without its account,
   * so the mailbox is switched off before the account goes. The save state
   * is `saving` from the switch's save until the removal settled, so no
   * other save or removal of the mailbox starts meanwhile. A removal resets
   * the check, so an outcome of the removed account is no longer shown.
   */
  readonly deleteEmailAccount: (
    mailbox: EmailMailbox,
    saveMailboxSwitchOff: () => Promise<McpSettingsSaveOutcome>
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
   * Saves one mailbox's account and its password in one write, serialized
   * with the other group saves; null removes both.
   */
  readonly saveEmailAccountSettings: (
    mailbox: EmailMailbox,
    account: EmailAccount | null,
    password: EmailPassword | null
  ) => Promise<void>
  /** Asks the backend to check an account; rejects on transport failure. */
  readonly sendEmailAccountCheck: (
    body: CheckEmailAccountApiRequestBody
  ) => Promise<CheckEmailAccountApiResponse>
}

/**
 * Builds the states of both mailboxes with one mailbox's replaced.
 *
 * @param states - The states before the change.
 * @param mailbox - The mailbox whose state changes.
 * @param state - Its new state.
 * @returns Frozen states, the other mailbox's kept.
 */
function replaceMailboxState<TState>(
  states: EmailMailboxStates<TState>,
  mailbox: EmailMailbox,
  state: TState
): EmailMailboxStates<TState> {
  return Object.freeze({ ...states, [mailbox]: state })
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
 * second save or removal of the same mailbox starts meanwhile, so the
 * outcome shown always concerns the account the file holds or the one just
 * tried. The store's account changes only after the file holds it, because
 * the backend reads the file: the MCP pane never shows an account as saved
 * that the email server would not get. Native writes are not cancellable;
 * leaving the pane cancels nothing.
 */
export function createEmailSettingsSlice(
  set: StoreApi<EmailSettingsStore>["setState"],
  get: StoreApi<EmailSettingsStore>["getState"],
  dependencies: EmailSettingsDependencies
): EmailSettingsSlice {
  /** Save state before any save. */
  const idleSave: EmailAccountSaveState = Object.freeze({ status: "idle" })

  /** Save state while a save or removal runs. */
  const saving: EmailAccountSaveState = Object.freeze({ status: "saving" })

  /** Check state before any check, or after a removal. */
  const idleCheck: EmailAccountCheckState = Object.freeze({ status: "idle" })

  /**
   * Answers whether a save or removal of a mailbox's account, or the check
   * of a save, runs now.
   *
   * @param mailbox - The mailbox.
   * @returns True while one does, so another of the mailbox must wait.
   */
  function isBusy(mailbox: EmailMailbox): boolean {
    const { emailAccountSaves, emailAccountChecks } = get()
    return (
      isEmailAccountSaveRunning(emailAccountSaves[mailbox]) ||
      isEmailAccountCheckRunning(emailAccountChecks[mailbox])
    )
  }

  /**
   * Publishes the latest save or removal of a mailbox's account.
   *
   * @param mailbox - The mailbox.
   * @param save - Its new save state.
   */
  function publishSave(
    mailbox: EmailMailbox,
    save: EmailAccountSaveState
  ): void {
    set((state) => ({
      emailAccountSaves: replaceMailboxState(
        state.emailAccountSaves,
        mailbox,
        save
      )
    }))
  }

  /**
   * Publishes the latest check of a mailbox's account.
   *
   * @param mailbox - The mailbox.
   * @param check - Its new check state.
   */
  function publishCheck(
    mailbox: EmailMailbox,
    check: EmailAccountCheckState
  ): void {
    set((state) => ({
      emailAccountChecks: replaceMailboxState(
        state.emailAccountChecks,
        mailbox,
        check
      )
    }))
  }

  /**
   * Publishes a new check of a mailbox's account, and the save state it
   * starts with, in one change.
   *
   * @param mailbox - The mailbox.
   * @param check - Its new check state.
   * @param save - Its new save state.
   */
  function publishCheckAndSave(
    mailbox: EmailMailbox,
    check: EmailAccountCheckState,
    save: EmailAccountSaveState
  ): void {
    const { emailAccountChecks, emailAccountSaves } = get()
    set({
      emailAccountChecks: replaceMailboxState(
        emailAccountChecks,
        mailbox,
        check
      ),
      emailAccountSaves: replaceMailboxState(emailAccountSaves, mailbox, save)
    })
  }

  /**
   * Saves a mailbox's account and its password, or removes both, and
   * publishes the outcome.
   *
   * @param mailbox - The mailbox.
   * @param saved - Account and password to save, both null to remove the
   * saved ones.
   * @returns `saved` once the file and the store hold the new value, or
   * `failed`.
   */
  async function saveAccountWithPassword(
    mailbox: EmailMailbox,
    saved: EmailMailboxAccount
  ): Promise<"saved" | "failed"> {
    /** Save state after a save or removal. */
    const savedState: EmailAccountSaveState = Object.freeze({ status: "saved" })

    publishSave(mailbox, saving)
    try {
      await dependencies.saveEmailAccountSettings(
        mailbox,
        saved.account,
        saved.password
      )
    } catch {
      /** Save state after a failed save or removal. */
      const saveFailed: EmailAccountSaveState = Object.freeze({
        status: "failed",
        error: "Lys couldn't write the email account to its settings file."
      })

      publishSave(mailbox, saveFailed)
      return "failed"
    }
    const { settings, emailAccountSaves } = get()
    set({
      settings: buildEmailMailboxAccountSettings(settings, mailbox, saved),
      emailAccountSaves: replaceMailboxState(
        emailAccountSaves,
        mailbox,
        savedState
      )
    })
    return "saved"
  }

  /**
   * Implements {@link EmailSettingsSlice.saveEmailAccount}.
   * @param mailbox - Whose account it is.
   * @param account - Account to check and save.
   * @param password - Its password.
   * @returns The save outcome.
   */
  async function saveEmailAccount(
    mailbox: EmailMailbox,
    account: EmailAccount,
    password: EmailPassword
  ): Promise<EmailAccountSaveOutcome> {
    /** Check state while a check runs. */
    const checking: EmailAccountCheckState = Object.freeze({
      status: "checking"
    })

    if (isBusy(mailbox)) return "busy"
    publishCheckAndSave(mailbox, checking, idleSave)
    let outcome: CheckEmailAccountApiResponse
    try {
      outcome = await dependencies.sendEmailAccountCheck({ account, password })
    } catch {
      /** Check state when the backend could not be asked. */
      const checkFailed: EmailAccountCheckState = Object.freeze({
        status: "failed",
        error: "Lys couldn't reach its backend to check the account."
      })

      publishCheck(mailbox, checkFailed)
      return "failed"
    }
    publishCheck(mailbox, Object.freeze({ status: "checked", outcome }))
    if (!isEmailAccountCheckAccepted(outcome)) return "refused"
    return await saveAccountWithPassword(mailbox, { account, password })
  }

  /**
   * Implements {@link EmailSettingsSlice.deleteEmailAccount}.
   * @param mailbox - Whose account to remove.
   * @param saveMailboxSwitchOff - Saves the mailbox's switch as off.
   * @returns The removal outcome.
   */
  async function deleteEmailAccount(
    mailbox: EmailMailbox,
    saveMailboxSwitchOff: () => Promise<McpSettingsSaveOutcome>
  ): Promise<EmailAccountRemovalOutcome> {
    /** Account and password of a mailbox once its account is removed. */
    const removed: EmailMailboxAccount = Object.freeze({
      account: null,
      password: null
    })

    if (isBusy(mailbox)) return "busy"
    publishCheckAndSave(mailbox, idleCheck, saving)
    if (isEmailMailboxOn(get().settings.mcp.builtIn.email, mailbox)) {
      /**
       * Save state after a removal that kept the account, because the
       * mailbox stayed on.
       */
      const switchOffFailed: EmailAccountSaveState = Object.freeze({
        status: "failed",
        error:
          "Lys couldn't switch this mailbox off, so the account wasn't removed."
      })

      const switchOutcome = await saveMailboxSwitchOff()
      switch (switchOutcome) {
        case "saved":
          break
        case "failed":
        case "busy":
          publishSave(mailbox, switchOffFailed)
          return "failed"
        default: {
          const unhandledOutcome: never = switchOutcome
          return unhandledOutcome
        }
      }
    }
    return await saveAccountWithPassword(mailbox, removed)
  }

  return {
    emailAccountSaves: Object.freeze({ person: idleSave, lys: idleSave }),
    emailAccountChecks: Object.freeze({ person: idleCheck, lys: idleCheck }),
    saveEmailAccount,
    deleteEmailAccount
  }
}
