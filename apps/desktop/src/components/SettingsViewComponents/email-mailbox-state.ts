import type { EmailAccount, EmailPassword } from "@lys/share"
import { useEffect } from "react"

import {
  findOtherEmailMailbox,
  isEmailMailboxOn,
  readEmailMailboxAccount,
  readEmailMailboxPassword,
  type EmailMailbox
} from "@/lib/models/email-mailbox"
import { useLysStore, type BackendServerStatus } from "@/lib/store"
import {
  isEmailAccountSaved,
  type EmailAccountCheckState,
  type EmailAccountRemovalOutcome,
  type EmailAccountSaveOutcome,
  type EmailAccountSaveState
} from "@/lib/store/email-settings"
import { useMcpServerStore } from "@/lib/store/mcp-servers"
import { isMcpSettingsSaveRunning } from "@/lib/store/mcp-settings"

import {
  findEmailMailboxConnection,
  type EmailMailboxConnection
} from "./email-mailbox-connection"

/** What the stores hold about one mailbox. */
export type EmailMailboxFacts = {
  /** Saved account, or null when none is saved. */
  readonly savedAccount: EmailAccount | null
  /** The other mailbox's saved account, or null. */
  readonly otherAccount: EmailAccount | null
  /** Saved password, or null when none is saved; never shown. */
  readonly savedPassword: EmailPassword | null
  /** Whether the email server serves the mailbox. */
  readonly isMailboxOn: boolean
  /** Whether a save of the MCP servers runs, which the switch waits for. */
  readonly isMailboxSwitchSaving: boolean
  /** Latest save or removal of the account. */
  readonly saveState: EmailAccountSaveState
  /** Latest check of the account. */
  readonly checkState: EmailAccountCheckState
  /** Whether the backend is running, which signing in needs. */
  readonly isBackendRunning: boolean
  /** Whether the mailbox is set up, switched on, and served. */
  readonly connection: EmailMailboxConnection
}

/** The saves a mailbox's views propose. */
export type EmailAccountSaves = {
  /** Checks and saves the account, then applies it while the mailbox is on. */
  readonly handleSaveEmailAccount: (
    account: EmailAccount,
    password: EmailPassword
  ) => Promise<EmailAccountSaveOutcome>
  /** Switches the mailbox off while it is on, then removes the account. */
  readonly handleRemoveEmailAccount: () => Promise<EmailAccountRemovalOutcome>
  /** Saves the mailbox's switch, which the store applies. */
  readonly handleMailboxOnChange: (isOn: boolean) => void
}

/**
 * Answers whether the backend answers requests.
 *
 * @param status - The backend's lifecycle state.
 * @returns True while it runs.
 */
export function isBackendServerRunning(status: BackendServerStatus): boolean {
  switch (status) {
    case "running":
      return true
    case "starting":
    case "stopping":
    case "stopped":
    case "unresponsive":
      return false
    default: {
      const unhandledStatus: never = status
      return unhandledStatus
    }
  }
}

/**
 * Reads what the stores hold about one mailbox.
 *
 * @remarks The application store owns the saved accounts and passwords,
 * each mailbox's save, check, and removal, the mailbox switches and their
 * save, and the backend's status; the MCP server store owns the email
 * server's state, which the connection follows.
 * @param mailbox - The mailbox.
 * @returns The mailbox's facts.
 */
export function useEmailMailboxFacts(mailbox: EmailMailbox): EmailMailboxFacts {
  const savedAccount = useLysStore((state) =>
    readEmailMailboxAccount(state.settings, mailbox)
  )
  const otherAccount = useLysStore((state) =>
    readEmailMailboxAccount(state.settings, findOtherEmailMailbox(mailbox))
  )
  const savedPassword = useLysStore((state) =>
    readEmailMailboxPassword(state.settings, mailbox)
  )
  const isMailboxOn = useLysStore((state) =>
    isEmailMailboxOn(state.settings.mcp.builtIn.email, mailbox)
  )
  const isMailboxSwitchSaving = useLysStore((state) =>
    isMcpSettingsSaveRunning(state.mcpSettingsSave)
  )
  const saveState = useLysStore((state) => state.emailAccountSaves[mailbox])
  const checkState = useLysStore((state) => state.emailAccountChecks[mailbox])
  const isBackendRunning = useLysStore((state) =>
    isBackendServerRunning(state.backendServerInfo.status)
  )
  const serverList = useMcpServerStore((state) => state.list)
  const connection = findEmailMailboxConnection({
    account: savedAccount,
    isMailboxOn,
    isBackendRunning,
    serverList
  })

  return {
    savedAccount,
    otherAccount,
    savedPassword,
    isMailboxOn,
    isMailboxSwitchSaving,
    saveState,
    checkState,
    isBackendRunning,
    connection
  }
}

/**
 * Reads the MCP servers' states while a saved mailbox is shown, so its
 * connection follows the email server.
 *
 * @remarks The MCP server store owns the read, which it shares with a read
 * already running, and polls while a server connects. A read starts when
 * the view appears, when the backend starts running, and when an account
 * is saved; nothing is read while the backend is stopped or no account is
 * saved. The hook returns nothing; the store publishes what the read finds.
 * @param facts - The mailbox's facts; reactive.
 */
export function useEmailServerStateRead(facts: EmailMailboxFacts): void {
  const loadMcpServers = useMcpServerStore((state) => state.loadMcpServers)
  const shouldRead = facts.isBackendRunning && facts.savedAccount !== null

  useEffect(() => {
    startEmailServerStateRead(shouldRead, loadMcpServers)
  }, [shouldRead, loadMcpServers])
}

/**
 * Starts a read of the MCP servers' states when the mailbox needs one.
 *
 * @param shouldRead - Whether the backend runs and an account is saved.
 * @param loadMcpServers - Starts the MCP server store's read, which commits
 * its failure and never rejects.
 */
function startEmailServerStateRead(
  shouldRead: boolean,
  loadMcpServers: () => Promise<void>
): void {
  if (shouldRead) void loadMcpServers()
}

/**
 * Owns the saves a mailbox's views propose: the account's save and
 * removal, and the mailbox's switch.
 *
 * @remarks The application store owns the account's save, check, and
 * removal; the MCP server store owns the switches' saves and the sync that
 * applies the group. Saving signs in through the backend first, which the
 * store does; once the account is saved while its mailbox is on, the
 * backend is asked to apply the group, so the server starts again with the
 * account. The store's removal switches the mailbox off first, because the
 * server cannot serve it without its account, and removes nothing when
 * that save fails. The handlers are rebuilt on every render and read the
 * stores when they run.
 * @param mailbox - The mailbox.
 * @returns The handlers.
 */
export function useEmailAccountSaves(mailbox: EmailMailbox): EmailAccountSaves {
  const saveEmailAccount = useLysStore((state) => state.saveEmailAccount)
  const deleteEmailAccount = useLysStore((state) => state.deleteEmailAccount)
  const saveEmailMailboxSwitch = useMcpServerStore(
    (state) => state.saveEmailMailboxSwitch
  )
  const sendMcpServerSync = useMcpServerStore(
    (state) => state.sendMcpServerSync
  )

  /**
   * Saves the account and, once saved while its mailbox is on, asks the
   * backend to apply the group.
   *
   * @param account - Valid account.
   * @param password - Its password.
   * @returns The save outcome.
   * @remarks The switch is read once the save settled, not when the save
   * started: the person can switch the mailbox on while the check runs, and
   * that switch's sync starts the server with the account saved before.
   */
  async function handleSaveEmailAccount(
    account: EmailAccount,
    password: EmailPassword
  ): Promise<EmailAccountSaveOutcome> {
    const outcome = await saveEmailAccount(mailbox, account, password)
    const isOnAfterSave = isEmailMailboxOn(
      useLysStore.getState().settings.mcp.builtIn.email,
      mailbox
    )
    if (isEmailAccountSaved(outcome) && isOnAfterSave) void sendMcpServerSync()
    return outcome
  }

  /**
   * Removes the account, switching its mailbox off first while it is on.
   *
   * @returns The removal outcome: `failed` when the switch or the removal
   * could not be saved, in which case the account stays.
   */
  function handleRemoveEmailAccount(): Promise<EmailAccountRemovalOutcome> {
    return deleteEmailAccount(mailbox, () =>
      saveEmailMailboxSwitch(mailbox, false)
    )
  }

  /**
   * Saves the mailbox's switch, which the store applies.
   *
   * @param isOn - Whether the email server serves the mailbox.
   */
  function handleMailboxOnChange(isOn: boolean): void {
    void saveEmailMailboxSwitch(mailbox, isOn)
  }

  return {
    handleSaveEmailAccount,
    handleRemoveEmailAccount,
    handleMailboxOnChange
  }
}
