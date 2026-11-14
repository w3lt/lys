import {
  emailAccountSchema,
  emailPasswordSchema,
  isSameEmailAddress,
  isSameEmailSignIn,
  MAXIMUM_TCP_PORT,
  type EmailAccount,
  type EmailAccountCandidate,
  type EmailPassword,
  type EmailSecurity,
  type EmailServerSettings
} from "@lys/share"

import type { EmailMailbox } from "./email-mailbox"
import { findEmailPreset, type EmailPreset } from "./email-presets"

/** One of the two mail servers of an account. */
export type EmailServerSide = "imap" | "smtp"

/** Text in the fields of one mail server. */
export type EmailServerDraft = {
  /** Host as typed. */
  readonly host: string
  /** Port as typed. */
  readonly port: string
  /** How the connection is secured. */
  readonly security: EmailSecurity
}

/** What the account card's fields hold, and which preset filled its servers. */
export type EmailAccountDraft = {
  /** Address as typed. */
  readonly address: string
  /** Display name as typed. */
  readonly displayName: string
  /** User name as typed. */
  readonly userName: string
  /** Password as typed; empty keeps the saved password. */
  readonly password: string
  /** Server mail is read from. */
  readonly imap: EmailServerDraft
  /** Server mail is sent through. */
  readonly smtp: EmailServerDraft
  /** Whether the SMTP server files a copy of each sent message itself. */
  readonly serverKeepsSentCopy: boolean
  /**
   * Preset that last filled the server fields and the Sent copy switch, or,
   * in the fields of a saved account, the saved address's preset; undefined
   * while neither exists. {@link canApplyEmailPreset} reads it to decide
   * whether another preset may fill the fields.
   */
  readonly appliedPreset: EmailPreset | undefined
}

/** Input of the account card a problem concerns. */
export type EmailAccountDraftField =
  | "address"
  | "displayName"
  | "userName"
  | "password"
  | "imapHost"
  | "imapPort"
  | "smtpHost"
  | "smtpPort"

/** First problem of each input that has one, as one sentence. */
export type EmailAccountDraftProblems = Readonly<
  Partial<Record<EmailAccountDraftField, string>>
>

/** Outcome of reading the fields as an account to save. */
export type EmailAccountDraftParse =
  | {
      /** The fields hold a valid account that differs from the saved one, or a new password. */
      readonly status: "changed"
      /** Account to save. */
      readonly account: EmailAccount
      /** Password to save: the typed one, or the saved one when none is typed. */
      readonly password: EmailPassword
    }
  | {
      /** The fields hold the saved account and no new password. */
      readonly status: "unchanged"
    }
  | {
      /** At least one field breaks a rule. */
      readonly status: "invalid"
      /** First problem of each input that has one. */
      readonly problems: EmailAccountDraftProblems
    }

/** What the fields of one mailbox's card are read against. */
export type EmailAccountDraftBasis = Readonly<{
  /** The mailbox the card saves. */
  mailbox: EmailMailbox
  /** The mailbox's saved account, or null. */
  savedAccount: EmailAccount | null
  /** Its saved password, or null. */
  savedPassword: EmailPassword | null
  /** The other mailbox's saved account, or null; the card may not open it. */
  otherAccount: EmailAccount | null
}>

/** Inputs in the order the card shows them. */
export const EMAIL_ACCOUNT_DRAFT_FIELDS: readonly EmailAccountDraftField[] =
  Object.freeze([
    "address",
    "displayName",
    "userName",
    "password",
    "imapHost",
    "imapPort",
    "smtpHost",
    "smtpPort"
  ])

/** Fields of a server with nothing typed, which Lys reaches with TLS. */
const EMPTY_SERVER_DRAFT: EmailServerDraft = Object.freeze({
  host: "",
  port: "",
  security: "tls"
})

/** The fields of an account card before anything is typed. */
const EMPTY_ACCOUNT_DRAFT: EmailAccountDraft = Object.freeze({
  address: "",
  displayName: "",
  userName: "",
  password: "",
  imap: EMPTY_SERVER_DRAFT,
  smtp: EMPTY_SERVER_DRAFT,
  serverKeepsSentCopy: false,
  appliedPreset: undefined
})

/**
 * The fields of each mailbox's card before anything is typed: Lys's own
 * starts with her name as the display name.
 */
const EMPTY_ACCOUNT_DRAFTS = Object.freeze({
  person: EMPTY_ACCOUNT_DRAFT,
  lys: Object.freeze({ ...EMPTY_ACCOUNT_DRAFT, displayName: "Lys" })
} satisfies Readonly<Record<EmailMailbox, EmailAccountDraft>>)

/** Where the card of each mailbox places a problem of one mailbox opened twice. */
type SameMailboxProblems = Readonly<{
  /** Problem placed on the address: the other mailbox's address. */
  address: string
  /** Problem placed on the user name: it signs in to the other mailbox. */
  signIn: string
}>

/**
 * What each mailbox's card says of an account that opens the other
 * mailbox.
 */
const SAME_MAILBOX_PROBLEMS = Object.freeze({
  person: Object.freeze({
    address: "This is the address of Lys's account.",
    signIn: "This signs in to Lys's mailbox."
  }),
  lys: Object.freeze({
    address:
      "This is the address of your own account. Lys needs an address of her own.",
    signIn: "This signs in to your own mailbox. Lys needs a mailbox of her own."
  })
} satisfies Readonly<Record<EmailMailbox, SameMailboxProblems>>)

/** Host and port inputs of one server side. */
type EmailServerFields = Readonly<
  Record<"host" | "port", EmailAccountDraftField>
>

/** One problem placed on an input. */
type PlacedProblem = readonly [EmailAccountDraftField, string]

/** One issue of the shared account schema, as far as the draft reads it. */
type AccountIssue = {
  /** Where the issue is within the account: the group, then the field. */
  readonly path: readonly PropertyKey[]
  /** The rule, as the schema words it. */
  readonly message: string
}

/** The password field read: the password to save, or its problem. */
type PasswordDraftParse =
  | {
      /** The field holds a password to save. */
      readonly status: "valid"
      /** The typed password, or the saved one while none is typed. */
      readonly password: EmailPassword
    }
  | {
      /** The field is empty while none is saved, or breaks its rule. */
      readonly status: "invalid"
      /** That a password must be entered, or the rule it breaks. */
      readonly problem: string
    }

/**
 * Builds the fields of one server from saved settings.
 *
 * @param server - Saved server.
 * @returns Its host, port as text, and security.
 */
function buildServerDraft(server: EmailServerSettings): EmailServerDraft {
  return {
    host: server.host,
    port: String(server.port),
    security: server.security
  }
}

/**
 * Builds the fields that show a saved account, or an empty card.
 *
 * @param account - Saved account, or null.
 * @param mailbox - The mailbox the card saves.
 * @returns The saved values with the password field empty, and the saved
 * address's preset as the one that filled the servers; without an account,
 * every text empty but, on Lys's card, the display name `Lys`, both servers
 * on TLS, Lys filing the Sent copy, and no preset.
 */
export function buildEmailAccountDraft(
  account: EmailAccount | null,
  mailbox: EmailMailbox
): EmailAccountDraft {
  if (account === null) return EMPTY_ACCOUNT_DRAFTS[mailbox]
  return {
    address: account.address,
    displayName: account.displayName,
    userName: account.userName,
    password: "",
    imap: buildServerDraft(account.imap),
    smtp: buildServerDraft(account.smtp),
    serverKeepsSentCopy: account.serverKeepsSentCopy,
    appliedPreset: findEmailPreset(account.address)
  }
}

/** Values that identify one mail server, as typed or as saved. */
type EmailServerValues = Readonly<{
  host: string
  port: string | number
  security: EmailSecurity
}>

/**
 * Answers whether two servers hold the same values.
 *
 * @typeParam TServer - Kind of both servers: typed fields, whose port is
 * text, or saved settings, whose port is a number.
 * @param first - One server.
 * @param second - Another server of the same kind.
 * @returns True when host, port, and security are equal.
 */
function isEmailServerEqual<TServer extends EmailServerValues>(
  first: TServer,
  second: TServer
): boolean {
  return (
    first.host === second.host &&
    first.port === second.port &&
    first.security === second.security
  )
}

/**
 * Answers whether a draft's server fields hold a preset's servers.
 *
 * @param draft - Fields as they are.
 * @param preset - Preset to compare with.
 * @returns True when both servers equal the preset's.
 */
export function hasEmailPresetServers(
  draft: EmailAccountDraft,
  preset: EmailPreset
): boolean {
  return (
    isEmailServerEqual(draft.imap, buildServerDraft(preset.imap)) &&
    isEmailServerEqual(draft.smtp, buildServerDraft(preset.smtp))
  )
}

/** The fields a preset fills: both servers and the Sent copy switch. */
type EmailServerChoices = Pick<
  EmailAccountDraft,
  "imap" | "smtp" | "serverKeepsSentCopy"
>

/**
 * Answers whether a draft's server fields and Sent copy switch hold given
 * values.
 *
 * @param draft - Fields as they are.
 * @param choices - Servers and switch to compare with.
 * @returns True when both servers and the switch are equal.
 */
function hasEmailServerChoices(
  draft: EmailAccountDraft,
  choices: EmailServerChoices
): boolean {
  return (
    isEmailServerEqual(draft.imap, choices.imap) &&
    isEmailServerEqual(draft.smtp, choices.smtp) &&
    draft.serverKeepsSentCopy === choices.serverKeepsSentCopy
  )
}

/**
 * Builds the fields a preset fills.
 *
 * @param preset - Preset to read.
 * @returns Its servers, the ports as text, and its Sent copy.
 */
function buildPresetChoices(preset: EmailPreset): EmailServerChoices {
  return {
    imap: buildServerDraft(preset.imap),
    smtp: buildServerDraft(preset.smtp),
    serverKeepsSentCopy: preset.serverKeepsSentCopy
  }
}

/**
 * Answers whether a preset may fill a draft's server fields and Sent copy
 * switch: every one of them still holds what an empty card holds, or they
 * all still hold the values of the draft's applied preset, the one that
 * last filled them or, for a saved account, its address's preset. Values
 * the person typed are never replaced, even ones that equal another
 * provider's preset.
 *
 * @param draft - Fields as they are.
 * @returns True when a preset may replace the server fields and the switch.
 */
function canApplyEmailPreset(draft: EmailAccountDraft): boolean {
  if (hasEmailServerChoices(draft, EMPTY_ACCOUNT_DRAFT)) return true
  const applied = draft.appliedPreset
  return (
    applied !== undefined &&
    hasEmailServerChoices(draft, buildPresetChoices(applied))
  )
}

/**
 * Replaces the address and, when its provider has a preset and the server
 * fields and the Sent copy switch are free to fill, fills them from it.
 *
 * @remarks An address typed one character at a time passes through texts
 * without a preset; the applied preset stays through them, so the preset
 * of the address typed in the end still replaces it.
 * @param draft - Fields as they are.
 * @param address - New address as typed.
 * @returns The draft with the address, and with the preset's servers and
 * Sent copy, recorded as the applied preset, while every server field and
 * the switch still hold what an empty card holds or the values of the
 * applied preset; otherwise the servers, the Sent copy, and the applied
 * preset stay as they are.
 */
export function updateEmailAccountAddress(
  draft: EmailAccountDraft,
  address: string
): EmailAccountDraft {
  const preset = findEmailPreset(address)
  if (preset === undefined || !canApplyEmailPreset(draft)) {
    return { ...draft, address }
  }
  return {
    ...draft,
    address,
    imap: buildServerDraft(preset.imap),
    smtp: buildServerDraft(preset.smtp),
    serverKeepsSentCopy: preset.serverKeepsSentCopy,
    appliedPreset: preset
  }
}

/**
 * Reads a port field.
 *
 * @param port - Text in the field, trimmed.
 * @returns The port as a number, or NaN when the text is not one to five
 * digits, which the shared rules refuse at the port.
 */
function parsePort(port: string): number {
  /** Finds a port as typed: one to five digits. */
  const portPattern = /^\d{1,5}$/

  return portPattern.test(port) ? Number(port) : Number.NaN
}

/**
 * Reads the fields of one server as the shared rules read them.
 *
 * @param server - Fields of the server.
 * @returns The host trimmed, the port as a number, and the security.
 */
function buildServerCandidate(
  server: EmailServerDraft
): EmailAccountCandidate["imap"] {
  return {
    host: server.host.trim(),
    port: parsePort(server.port.trim()),
    security: server.security
  }
}

/**
 * Reads the fields as the shared rules read them.
 *
 * @param draft - Fields as they are.
 * @returns The account before validation: the texts trimmed, the ports as
 * numbers.
 */
function buildAccountCandidate(
  draft: EmailAccountDraft
): EmailAccountCandidate {
  return {
    address: draft.address.trim(),
    displayName: draft.displayName.trim(),
    userName: draft.userName.trim(),
    imap: buildServerCandidate(draft.imap),
    smtp: buildServerCandidate(draft.smtp),
    serverKeepsSentCopy: draft.serverKeepsSentCopy
  }
}

/**
 * Builds the problem of one server issue, placed on an input.
 *
 * @param side - Server the issue concerns.
 * @param part - Field of the server the issue names, or undefined for the
 * server as a whole, which is the rule about connections without TLS.
 * @param message - The rule, as the schema words it.
 * @returns The port input with the port rule in the card's words; the host
 * input with the rule otherwise, because a connection without TLS is fixed
 * at the host or beside it.
 */
function buildPlacedServerProblem(
  side: EmailServerSide,
  part: PropertyKey | undefined,
  message: string
): PlacedProblem {
  /** Problem of a port that is not a whole number in the TCP range. */
  const portProblem = `A port is a whole number from 1 to ${MAXIMUM_TCP_PORT}.`

  /** Host and port inputs of the IMAP server. */
  const imapServerFields = Object.freeze({
    host: "imapHost",
    port: "imapPort"
  } satisfies EmailServerFields)

  /** Host and port inputs of the SMTP server. */
  const smtpServerFields = Object.freeze({
    host: "smtpHost",
    port: "smtpPort"
  } satisfies EmailServerFields)

  /** Host and port inputs of each server side. */
  const serverFields = Object.freeze({
    imap: imapServerFields,
    smtp: smtpServerFields
  } satisfies Readonly<Record<EmailServerSide, EmailServerFields>>)

  const fields = serverFields[side]
  if (part === "port") return [fields.port, portProblem]
  return [fields.host, message]
}

/**
 * Finds the input one account issue concerns, and builds its problem.
 *
 * @param issue - The issue.
 * @returns The input and the problem, or undefined for an issue of no
 * input, which the schema does not report.
 */
function findPlacedAccountProblem(
  issue: AccountIssue
): PlacedProblem | undefined {
  const [group, part] = issue.path
  switch (group) {
    case "address":
    case "displayName":
    case "userName":
      return [group, issue.message]
    case "imap":
    case "smtp":
      return buildPlacedServerProblem(group, part, issue.message)
    default:
      return undefined
  }
}

/**
 * Parses the password field.
 *
 * @param password - Text in the field, as typed.
 * @param savedPassword - Saved password, or null.
 * @returns The typed password when it follows the rule, the saved one
 * while nothing is typed, or the problem: an empty field while none is
 * saved, or the rule a typed password breaks.
 */
function parsePasswordDraft(
  password: string,
  savedPassword: EmailPassword | null
): PasswordDraftParse {
  if (password === "") {
    /** Problem of an empty password while none is saved. */
    const emptyPasswordProblem = "Enter the password."

    return savedPassword === null
      ? { status: "invalid", problem: emptyPasswordProblem }
      : { status: "valid", password: savedPassword }
  }
  const parsed = emailPasswordSchema.safeParse(password)
  return parsed.success
    ? { status: "valid", password: parsed.data }
    : { status: "invalid", problem: parsed.error.issues[0]?.message ?? "" }
}

/**
 * Finds the problem of the password field, placed on its input.
 *
 * @param password - The password field read.
 * @returns The password input and its problem, or undefined while the
 * field holds a password to save.
 */
function findPlacedPasswordProblem(
  password: PasswordDraftParse
): PlacedProblem | undefined {
  switch (password.status) {
    case "invalid":
      return ["password", password.problem]
    case "valid":
      return undefined
    default: {
      const unhandledPassword: never = password
      return unhandledPassword
    }
  }
}

/**
 * Builds the first problem of each input.
 *
 * @param placed - Problems in the schema's order, an input possibly
 * repeated or a problem placed nowhere.
 * @returns The first problem of each input, keyed by input.
 */
function buildDraftProblems(
  placed: readonly (PlacedProblem | undefined)[]
): EmailAccountDraftProblems {
  const problems: Partial<Record<EmailAccountDraftField, string>> = {}
  for (const entry of placed) {
    if (entry !== undefined) problems[entry[0]] ??= entry[1]
  }
  return problems
}

/**
 * Finds the problems of an account that opens the other mailbox, placed on
 * the inputs that make it so.
 *
 * @param account - Valid account read from the fields.
 * @param basis - The card's mailbox and the other mailbox's saved account.
 * @returns The address's problem when the addresses are equal, and the user
 * name's when both sign in alike, as `@lys/share` compares them; none while
 * the other mailbox has no account.
 */
function findSameMailboxProblems(
  account: EmailAccount,
  basis: EmailAccountDraftBasis
): readonly PlacedProblem[] {
  const { otherAccount } = basis
  if (otherAccount === null) return []
  const messages = SAME_MAILBOX_PROBLEMS[basis.mailbox]
  const problems: PlacedProblem[] = []
  if (isSameEmailAddress(account, otherAccount))
    problems.push(["address", messages.address])
  if (isSameEmailSignIn(account, otherAccount))
    problems.push(["userName", messages.signIn])
  return problems
}

/**
 * Answers whether an account equals the saved one.
 *
 * @param account - Account read from the fields.
 * @param savedAccount - Saved account, or null.
 * @returns True when every field is equal.
 */
function isEmailAccountEqual(
  account: EmailAccount,
  savedAccount: EmailAccount | null
): boolean {
  return (
    savedAccount !== null &&
    account.address === savedAccount.address &&
    account.displayName === savedAccount.displayName &&
    account.userName === savedAccount.userName &&
    account.serverKeepsSentCopy === savedAccount.serverKeepsSentCopy &&
    isEmailServerEqual(account.imap, savedAccount.imap) &&
    isEmailServerEqual(account.smtp, savedAccount.smtp)
  )
}

/**
 * Reads the fields as an account and a password to save.
 *
 * @param draft - Fields as they are.
 * @param basis - The card's mailbox, its saved account and password, and
 * the other mailbox's saved account.
 * @returns `invalid` with the first problem of each input when the address,
 * a name, or a host, trimmed, breaks the shared rules, a port is not a
 * whole number from 1 to {@link MAXIMUM_TCP_PORT}, a connection without
 * TLS names a host that is not this machine, which the host input says,
 * the account opens the other mailbox, which the address or the user name
 * says, or the password is empty while none is saved or breaks its rule;
 * otherwise `changed` with the account and the password to save when the
 * account differs from the saved one or a password is typed, or
 * `unchanged`. The password is read as typed, and an empty password field
 * keeps the saved password.
 */
export function parseEmailAccountDraft(
  draft: EmailAccountDraft,
  basis: EmailAccountDraftBasis
): EmailAccountDraftParse {
  const account = emailAccountSchema.safeParse(buildAccountCandidate(draft))
  const password = parsePasswordDraft(draft.password, basis.savedPassword)
  const accountProblems = account.success
    ? findSameMailboxProblems(account.data, basis)
    : account.error.issues.map(findPlacedAccountProblem)
  const problems = buildDraftProblems([
    ...accountProblems,
    findPlacedPasswordProblem(password)
  ])
  if (!account.success || accountProblems.length > 0)
    return { status: "invalid", problems }
  switch (password.status) {
    case "valid":
      if (
        draft.password === "" &&
        isEmailAccountEqual(account.data, basis.savedAccount)
      ) {
        return { status: "unchanged" }
      }
      return {
        status: "changed",
        account: account.data,
        password: password.password
      }
    case "invalid":
      return { status: "invalid", problems }
    default: {
      const unhandledPassword: never = password
      return unhandledPassword
    }
  }
}

/**
 * Answers whether the fields hold other values than the card shows for the
 * saved account, whether or not they follow the rules.
 *
 * @param draft - Fields as they are.
 * @param savedAccount - Saved account, or null for an empty card.
 * @param mailbox - The mailbox the card saves.
 * @returns True when a text differs as typed, a password is typed, or a
 * server or the Sent copy switch differs.
 */
export function isEmailAccountDraftDifferent(
  draft: EmailAccountDraft,
  savedAccount: EmailAccount | null,
  mailbox: EmailMailbox
): boolean {
  const shown = buildEmailAccountDraft(savedAccount, mailbox)
  return !(
    draft.address === shown.address &&
    draft.displayName === shown.displayName &&
    draft.userName === shown.userName &&
    draft.password === shown.password &&
    hasEmailServerChoices(draft, shown)
  )
}
