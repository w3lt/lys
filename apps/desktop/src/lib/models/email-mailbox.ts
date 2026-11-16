import type {
  BuiltInMcpSettings,
  EmailAccount,
  EmailPassword,
  EmailSettings
} from "@lys/share"

import type { LysSettings, SecretsSettings } from "@/lib/store/settings"

/**
 * Whose mailbox an account opens: the person's own, or Lys's own, which
 * Lys reads and sends from as herself.
 */
export type EmailMailbox = "person" | "lys"

/** The email server's mailbox switches. */
export type EmailMailboxSwitches = BuiltInMcpSettings["email"]

/** One mailbox's account and password, saved or removed together. */
export type EmailMailboxAccount = Readonly<{
  /** The account, or null when none is saved. */
  account: EmailAccount | null
  /** Its password, or null when none is saved; a secret. */
  password: EmailPassword | null
}>

/** Where the settings keep one mailbox's account, password, and switch. */
type EmailMailboxFields = Readonly<{
  /** Field of the `email` group that holds the account. */
  account: keyof EmailSettings
  /** Field of the secrets group that holds the password. */
  password: "emailPassword" | "lysEmailPassword"
  /** Field of the email server's switches that serves the mailbox. */
  switch: keyof EmailMailboxSwitches
}>

/**
 * Where the settings keep each mailbox: the person's under the names the
 * fields had before Lys had a mailbox, and Lys's under names of her own.
 */
const EMAIL_MAILBOX_FIELDS = Object.freeze({
  person: Object.freeze({
    account: "account",
    password: "emailPassword",
    switch: "enabled"
  }),
  lys: Object.freeze({
    account: "lysAccount",
    password: "lysEmailPassword",
    switch: "lysEnabled"
  })
} as const satisfies Readonly<Record<EmailMailbox, EmailMailboxFields>>)

/**
 * Names the other mailbox.
 *
 * @param mailbox - One mailbox.
 * @returns The other one.
 */
export function findOtherEmailMailbox(mailbox: EmailMailbox): EmailMailbox {
  return mailbox === "person" ? "lys" : "person"
}

/**
 * Reads one mailbox's saved account.
 *
 * @param settings - The `email` group.
 * @param mailbox - The mailbox.
 * @returns Its account, or null when none is saved.
 */
export function readEmailMailboxAccount(
  settings: Pick<LysSettings, "email">,
  mailbox: EmailMailbox
): EmailAccount | null {
  return settings.email[EMAIL_MAILBOX_FIELDS[mailbox].account]
}

/**
 * Reads one mailbox's saved password.
 *
 * @param settings - The secrets group.
 * @param mailbox - The mailbox.
 * @returns Its password, or null when none is saved; a secret.
 */
export function readEmailMailboxPassword(
  settings: Pick<LysSettings, "secrets">,
  mailbox: EmailMailbox
): EmailPassword | null {
  return settings.secrets[EMAIL_MAILBOX_FIELDS[mailbox].password]
}

/**
 * Answers whether the email server serves one mailbox.
 *
 * @param switches - The email server's mailbox switches.
 * @param mailbox - The mailbox.
 * @returns True while its switch is on.
 */
export function isEmailMailboxOn(
  switches: EmailMailboxSwitches,
  mailbox: EmailMailbox
): boolean {
  return switches[EMAIL_MAILBOX_FIELDS[mailbox].switch]
}

/**
 * Builds the settings that hold one mailbox's account and password, or
 * neither.
 *
 * @param settings - Settings before the change.
 * @param mailbox - The mailbox.
 * @param saved - Account and password the file now holds, both null after
 * a removal.
 * @returns Frozen `email` and secrets groups with the mailbox's account and
 * password replaced, every other group, account, and secret kept.
 */
export function buildEmailMailboxAccountSettings(
  settings: LysSettings,
  mailbox: EmailMailbox,
  saved: EmailMailboxAccount
): LysSettings {
  const fields = EMAIL_MAILBOX_FIELDS[mailbox]
  const secrets: SecretsSettings = Object.freeze({
    ...settings.secrets,
    [fields.password]: saved.password
  })
  const email: EmailSettings = Object.freeze({
    ...settings.email,
    [fields.account]: saved.account
  })
  return { ...settings, secrets, email }
}

/**
 * Builds the email server's switches with one mailbox's switch set.
 *
 * @param switches - The switches before the change.
 * @param mailbox - The mailbox.
 * @param isOn - Whether the server serves it.
 * @returns Frozen switches, the other mailbox's kept.
 */
export function buildEmailMailboxSwitches(
  switches: EmailMailboxSwitches,
  mailbox: EmailMailbox,
  isOn: boolean
): EmailMailboxSwitches {
  return Object.freeze({
    ...switches,
    [EMAIL_MAILBOX_FIELDS[mailbox].switch]: isOn
  })
}
