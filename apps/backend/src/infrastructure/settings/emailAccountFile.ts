import {
  emailPasswordSchema,
  emailSettingsSchema,
  type EmailAccount,
  type EmailPassword
} from "@lys/share"
import * as z from "zod"
import { readSettingsFileText } from "./settingsFile"

/**
 * What reading one email account from the settings file found.
 *
 * @remarks `read`: the `email` group holds an account that passed its
 * rules, and the `secrets` group holds a password that passed its rule.
 * `missing`: no file, no `email` group, no account field, or `null`,
 * which are the declared forms of "no account". `invalid`: the `email`
 * group or the account fails its rules, or the account is saved without a
 * usable password: no `secrets` group, no password field, or one that
 * fails its rule. `unreadable`: the file cannot be read, is larger than the
 * limit {@link readSettingsFileText} applies, is not UTF-8, or is not a
 * JSON object. A read or decode failure is never reported as `missing`.
 */
export type EmailAccountRead =
  | Readonly<{
      /** A usable account and its password are saved. */
      status: "read"
      /** The saved account; personal data. */
      account: EmailAccount
      /** The saved password; a secret. */
      password: EmailPassword
    }>
  | Readonly<{
      /** No account is saved. */
      status: "missing"
    }>
  | Readonly<{
      /** The group, the account, or the password fails its rules, or the password is missing. */
      status: "invalid"
    }>
  | Readonly<{
      /** The file could not be read as a settings document. */
      status: "unreadable"
    }>

/**
 * What one read of the settings file found for each email account: the
 * person's, `email.account` with `secrets.emailPassword`, and Lys's own,
 * `email.lysAccount` with `secrets.lysEmailPassword`.
 *
 * @remarks Both come from the same read of the file, so they never mix two
 * versions of it. A group that breaks the shared rules, such as two
 * accounts of one mailbox, reads as `invalid` for both.
 */
export type EmailAccountsRead = Readonly<{
  /** The person's account. */
  person: EmailAccountRead
  /** Lys's own account. */
  lys: EmailAccountRead
}>

/**
 * Validates the part of the settings document this reader uses.
 *
 * @remarks The desktop host owns and validates the whole document. This
 * reader takes only the `email` and `secrets` groups; every other group is
 * dropped unread, so a group it does not know never makes the account
 * unreadable, and nothing ignored is kept.
 */
const settingsEmailSchema = z.object({
  email: z.unknown().optional(),
  secrets: z.unknown().optional()
})

/** The part of the settings document this reader uses. */
type SettingsEmail = z.infer<typeof settingsEmailSchema>

/** Read result when no account is saved. */
const MISSING_ACCOUNT: EmailAccountRead = Object.freeze({ status: "missing" })

/** Read result when the saved account or password fails its rules. */
const INVALID_ACCOUNT: EmailAccountRead = Object.freeze({ status: "invalid" })

/** Read of both accounts when the file holds no settings document. */
const UNREADABLE_SETTINGS: EmailAccountsRead = Object.freeze({
  person: Object.freeze({ status: "unreadable" }),
  lys: Object.freeze({ status: "unreadable" })
})

/** Read of both accounts when no file is saved. */
const MISSING_ACCOUNTS: EmailAccountsRead = Object.freeze({
  person: MISSING_ACCOUNT,
  lys: MISSING_ACCOUNT
})

/** Read of both accounts when the `email` group breaks its rules. */
const INVALID_ACCOUNTS: EmailAccountsRead = Object.freeze({
  person: INVALID_ACCOUNT,
  lys: INVALID_ACCOUNT
})

/**
 * Reads both email accounts and their passwords from the desktop's
 * settings file.
 *
 * @param settingsFilePath - Absolute path of `settings.json`.
 * @returns What the file holds for each account, as
 * {@link EmailAccountsRead} describes. Each call reads the file again.
 * @throws Only when closing the opened file fails.
 * @remarks Reads at most the bytes {@link readSettingsFileText} allows and
 * never writes. Nothing read from the file leaves this function except
 * accounts and passwords that passed their rules: parse failures are
 * dropped, because JSON parse messages quote the text, which can hold a
 * password. The desktop host replaces the file atomically, so a read sees
 * a whole document.
 */
export async function readEmailAccounts(
  settingsFilePath: string
): Promise<EmailAccountsRead> {
  const file = await readSettingsFileText(settingsFilePath)
  switch (file.status) {
    case "missing":
      return MISSING_ACCOUNTS
    case "unreadable":
      return UNREADABLE_SETTINGS
    case "read":
      return parseEmailAccounts(file.text)
  }
}

/**
 * Parses both accounts and their passwords out of settings file text.
 *
 * @param text - Text of the settings file.
 * @returns What the text holds for each account, as
 * {@link EmailAccountsRead} describes.
 * @remarks The `email` group is judged by the shared group rules, as the
 * desktop host judges it, before an account is looked at, so a group that
 * breaks them is `invalid` for both accounts even when it holds none.
 */
function parseEmailAccounts(text: string): EmailAccountsRead {
  /**
   * Validates the password of the person's account in the `secrets` group.
   *
   * @remarks Every other secret is dropped unread. A missing or `null`
   * password fails, because an account is read only with its password.
   */
  const personPasswordSchema = z
    .object({ emailPassword: emailPasswordSchema })
    .transform((secrets) => secrets.emailPassword)

  /**
   * Validates the password of Lys's account in the `secrets` group.
   *
   * @remarks As for the person's password.
   */
  const lysPasswordSchema = z
    .object({ lysEmailPassword: emailPasswordSchema })
    .transform((secrets) => secrets.lysEmailPassword)

  /** The `email` group of a file that has none. */
  const noEmailGroup: unknown = Object.freeze({})

  const document = parseSettingsEmail(text)
  if (document === undefined) return UNREADABLE_SETTINGS
  const group = emailSettingsSchema.safeParse(
    document.email === undefined ? noEmailGroup : document.email
  )
  if (!group.success) return INVALID_ACCOUNTS
  return Object.freeze({
    person: buildAccountRead(
      group.data.account,
      personPasswordSchema.safeParse(document.secrets)
    ),
    lys: buildAccountRead(
      group.data.lysAccount,
      lysPasswordSchema.safeParse(document.secrets)
    )
  })
}

/**
 * Builds the read of one account from the account the group holds and the
 * outcome of reading its password.
 *
 * @param account - The account the valid group holds, or `null` for none.
 * @param password - Outcome of validating the account's password field of
 * the `secrets` group.
 * @returns `missing` without an account, `invalid` when the password did
 * not pass its rule or is missing, and `read` otherwise.
 */
function buildAccountRead(
  account: EmailAccount | null,
  password: z.ZodSafeParseResult<EmailPassword>
): EmailAccountRead {
  if (account === null) return MISSING_ACCOUNT
  if (!password.success) return INVALID_ACCOUNT
  return Object.freeze({ status: "read", account, password: password.data })
}

/**
 * Parses settings file text into the part this reader uses.
 *
 * @param text - Text of the settings file.
 * @returns The part, or undefined when the text is not JSON or not an
 * object.
 * @remarks A parse failure is dropped, never kept or logged, because its
 * message can quote the text.
 */
function parseSettingsEmail(text: string): SettingsEmail | undefined {
  try {
    const document: unknown = JSON.parse(text)
    const parsed = settingsEmailSchema.safeParse(document)
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}
