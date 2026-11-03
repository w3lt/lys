import {
  emailPasswordSchema,
  emailSettingsSchema,
  type EmailAccount,
  type EmailPassword
} from "@lys/share"
import * as z from "zod"
import { readSettingsFileText } from "./settingsFile"

/**
 * What reading the email account from the settings file found.
 *
 * @remarks `read`: the `email` group holds an account that passed its
 * rules, and the `secrets` group holds a password that passed its rule.
 * `missing`: no file, no `email` group, no account field, or `null`,
 * which are the declared forms of "no account". `invalid`: the `email`
 * group or its account fails its rules, or an account is saved without a
 * usable password: no `secrets` group, no `emailPassword`, or one that
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

/**
 * Validates the part of the `secrets` group this reader uses: the password
 * of the saved account.
 *
 * @remarks Every other secret is dropped unread. A missing or `null`
 * password fails, because an account is read only with its password.
 */
const secretsEmailPasswordSchema = z.object({
  emailPassword: emailPasswordSchema
})

/** The `email` group of a file that has none. */
const NO_EMAIL_GROUP: unknown = Object.freeze({})

/** Read result when no account is saved. */
const MISSING_ACCOUNT: EmailAccountRead = Object.freeze({ status: "missing" })

/** Read result when the saved account or password fails its rules. */
const INVALID_ACCOUNT: EmailAccountRead = Object.freeze({ status: "invalid" })

/** Read result when the file cannot be read as a settings document. */
const UNREADABLE_SETTINGS: EmailAccountRead = Object.freeze({
  status: "unreadable"
})

/**
 * Reads the email account and its password from the desktop's settings
 * file.
 *
 * @param settingsFilePath - Absolute path of `settings.json`.
 * @returns What the file holds, as {@link EmailAccountRead} describes. Each
 * call reads the file again.
 * @throws Only when closing the opened file fails.
 * @remarks Reads at most the bytes {@link readSettingsFileText} allows and
 * never writes. Nothing read from the file leaves this function except an
 * account and a password that passed their rules: parse failures are
 * dropped, because JSON parse messages quote the text, which can hold the
 * password. The desktop host replaces the file atomically, so a read sees
 * a whole document.
 */
export async function readEmailAccount(
  settingsFilePath: string
): Promise<EmailAccountRead> {
  const file = await readSettingsFileText(settingsFilePath)
  switch (file.status) {
    case "missing":
      return MISSING_ACCOUNT
    case "unreadable":
      return UNREADABLE_SETTINGS
    case "read":
      return parseEmailAccount(file.text)
  }
}

/**
 * Parses the account and its password out of settings file text.
 *
 * @param text - Text of the settings file.
 * @returns `read`, `missing`, `invalid`, or `unreadable` as
 * {@link EmailAccountRead} describes.
 * @remarks The `email` group is judged by the shared group rules, as the
 * desktop host judges it, before the account is looked at, so a group that
 * breaks them is `invalid` even when it holds no account.
 */
function parseEmailAccount(text: string): EmailAccountRead {
  const document = parseSettingsEmail(text)
  if (document === undefined) return UNREADABLE_SETTINGS
  const group = emailSettingsSchema.safeParse(
    document.email === undefined ? NO_EMAIL_GROUP : document.email
  )
  if (!group.success) return INVALID_ACCOUNT
  if (group.data.account === null) return MISSING_ACCOUNT
  const secrets = secretsEmailPasswordSchema.safeParse(document.secrets)
  if (!secrets.success) return INVALID_ACCOUNT
  return Object.freeze({
    status: "read",
    account: group.data.account,
    password: secrets.data.emailPassword
  })
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
