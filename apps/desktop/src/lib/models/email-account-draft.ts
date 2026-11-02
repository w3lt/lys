import {
  emailAccountSchema,
  emailPasswordSchema,
  MAXIMUM_TCP_PORT,
  type EmailAccount,
  type EmailAccountCandidate,
  type EmailPassword,
  type EmailSecurity,
  type EmailServerSettings
} from "@lys/share"

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

/** What the account card's fields hold. */
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

/** Problem of a port that is not a whole number in the TCP range. */
const PORT_PROBLEM = `A port is a whole number from 1 to ${MAXIMUM_TCP_PORT}.`

/** Problem of an empty password while none is saved. */
const EMPTY_PASSWORD_PROBLEM = "Enter the password."

/** Finds a port as typed: one to five digits. */
const PORT_PATTERN = /^\d{1,5}$/

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
  serverKeepsSentCopy: false
})

/** Host and port inputs of one server side. */
type EmailServerFields = Readonly<
  Record<"host" | "port", EmailAccountDraftField>
>

/** Host and port inputs of the IMAP server. */
const IMAP_SERVER_FIELDS = Object.freeze({
  host: "imapHost",
  port: "imapPort"
} satisfies EmailServerFields)

/** Host and port inputs of the SMTP server. */
const SMTP_SERVER_FIELDS = Object.freeze({
  host: "smtpHost",
  port: "smtpPort"
} satisfies EmailServerFields)

/** Host and port inputs of each server side. */
const SERVER_FIELDS = Object.freeze({
  imap: IMAP_SERVER_FIELDS,
  smtp: SMTP_SERVER_FIELDS
} satisfies Readonly<Record<EmailServerSide, EmailServerFields>>)

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
  { readonly password: EmailPassword } | { readonly problem: string }

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
 * @returns The saved values with the password field empty; without an
 * account, every text empty, both servers on TLS, and Lys filing the Sent
 * copy.
 */
export function buildEmailAccountDraft(
  account: EmailAccount | null
): EmailAccountDraft {
  if (account === null) return EMPTY_ACCOUNT_DRAFT
  return {
    address: account.address,
    displayName: account.displayName,
    userName: account.userName,
    password: "",
    imap: buildServerDraft(account.imap),
    smtp: buildServerDraft(account.smtp),
    serverKeepsSentCopy: account.serverKeepsSentCopy
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
 * all still hold the preset of the address they were filled for.
 *
 * @param draft - Fields as they are, with the address before its change.
 * @returns True when a preset may replace the server fields and the switch.
 */
function canApplyEmailPreset(draft: EmailAccountDraft): boolean {
  if (hasEmailServerChoices(draft, EMPTY_ACCOUNT_DRAFT)) return true
  const applied = findEmailPreset(draft.address)
  return (
    applied !== undefined &&
    hasEmailServerChoices(draft, buildPresetChoices(applied))
  )
}

/**
 * Replaces the address and, when its provider has a preset and the server
 * fields and the Sent copy switch are free to fill, fills them from it.
 *
 * @param draft - Fields as they are.
 * @param address - New address as typed.
 * @returns The draft with the address, and with the preset's servers and
 * Sent copy while every server field and the switch still hold what an
 * empty card holds, or they all still hold the preset applied for the
 * previous address; otherwise the servers and the Sent copy the person
 * made or kept stay as they are.
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
    serverKeepsSentCopy: preset.serverKeepsSentCopy
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
  return PORT_PATTERN.test(port) ? Number(port) : Number.NaN
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
  const fields = SERVER_FIELDS[side]
  if (part === "port") return [fields.port, PORT_PROBLEM]
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
    return savedPassword === null
      ? { problem: EMPTY_PASSWORD_PROBLEM }
      : { password: savedPassword }
  }
  const parsed = emailPasswordSchema.safeParse(password)
  return parsed.success
    ? { password: parsed.data }
    : { problem: parsed.error.issues[0]?.message ?? "" }
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
 * @param savedAccount - Saved account, or null.
 * @param savedPassword - Saved password, or null.
 * @returns `invalid` with the first problem of each input when the address,
 * a name, or a host, trimmed, breaks the shared rules, a port is not a
 * whole number from 1 to {@link MAXIMUM_TCP_PORT}, a connection without
 * TLS names a host that is not this machine, which the host input says,
 * or the password is empty while none is saved or breaks its rule;
 * otherwise `changed` with the account and the password to save when the
 * account differs from the saved one or a password is typed, or
 * `unchanged`. The password is read as typed, and an empty password field
 * keeps the saved password.
 */
export function parseEmailAccountDraft(
  draft: EmailAccountDraft,
  savedAccount: EmailAccount | null,
  savedPassword: EmailPassword | null
): EmailAccountDraftParse {
  const account = emailAccountSchema.safeParse(buildAccountCandidate(draft))
  const password = parsePasswordDraft(draft.password, savedPassword)
  const problems = buildDraftProblems([
    ...(account.success
      ? []
      : account.error.issues.map(findPlacedAccountProblem)),
    "problem" in password ? ["password", password.problem] : undefined
  ])
  if (!account.success || "problem" in password) {
    return { status: "invalid", problems }
  }
  if (
    draft.password === "" &&
    isEmailAccountEqual(account.data, savedAccount)
  ) {
    return { status: "unchanged" }
  }
  return {
    status: "changed",
    account: account.data,
    password: password.password
  }
}
