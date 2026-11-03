import type {
  CheckEmailAccountApiResponse,
  EmailAccountCheckUnavailableReason,
  EmailServerCheck,
  EmailServerCheckFailure
} from "@lys/protocol"
import {
  emailAddressSchema,
  emailSecuritySchema,
  MAXIMUM_TCP_PORT,
  type EmailAccount,
  type EmailSecurity
} from "@lys/share"

import {
  EMAIL_ACCOUNT_DRAFT_FIELDS,
  hasEmailPresetServers,
  type EmailAccountDraft,
  type EmailAccountDraftField,
  type EmailAccountDraftParse,
  type EmailAccountDraftProblems,
  type EmailServerSide
} from "@/lib/models/email-account-draft"
import { findEmailPreset } from "@/lib/models/email-presets"
import type {
  EmailAccountCheckState,
  EmailAccountSaveState
} from "@/lib/store/email-settings"

import type { McpDraftProblemListing } from "./mcp-presentation"

/** Tone of the account card's status line. */
type EmailTone = "muted" | "pending" | "attention" | "success" | "danger"

/** Line under the account fields. */
export type EmailAccountMessage = {
  /** Text of the line. */
  readonly text: string
  /** Tone of the line. */
  readonly tone: EmailTone
}

/** Facts the account card's status line describes. */
type EmailAccountStatusInput = {
  /** Saved account, or null. */
  readonly savedAccount: EmailAccount | null
  /** Outcome of reading the fields. */
  readonly draftParse: EmailAccountDraftParse
  /**
   * Whether the fields hold other values than the card shows for the saved
   * account, whether or not they follow the rules.
   */
  readonly isDraftDifferent: boolean
  /** Whether a save was tried, from which the fields' problems are shown. */
  readonly hasSubmitted: boolean
  /**
   * Whether the fields changed since the last save was tried, after which
   * what that save found no longer concerns them.
   */
  readonly isEditedSinceSubmit: boolean
  /** Latest save or removal. */
  readonly saveState: EmailAccountSaveState
  /** Latest check. */
  readonly checkState: EmailAccountCheckState
  /** Whether the backend is running, which the check needs. */
  readonly isBackendRunning: boolean
}

/** Note under the account card's heading. */
export const EMAIL_ACCOUNT_NOTE =
  "Lys signs in to IMAP and SMTP before saving. Gmail, iCloud, and Yahoo need an app password."

/** Note of the password field while a password is saved. */
export const EMAIL_PASSWORD_KEPT_NOTE =
  "Leave empty to keep the saved password."

/** Note under the Sent copy switch. */
export const EMAIL_SENT_COPY_NOTE =
  "Gmail and Yahoo file sent mail themselves. Off makes Lys file the copy in Sent."

/** Rule of a port, shown beside its label before entry. */
export const EMAIL_PORT_HINT = `1–${MAXIMUM_TCP_PORT}`

/** Question asked before removing the account. */
export const EMAIL_ACCOUNT_REMOVAL_QUESTION =
  "Remove the email account and its password? The email server is switched off."

/** Ways to secure a connection, in the order the card offers them. */
export const EMAIL_SECURITIES: readonly EmailSecurity[] =
  emailSecuritySchema.options

/** Label of each way to secure a connection; a new way must add one. */
const EMAIL_SECURITY_LABELS = Object.freeze({
  tls: "TLS",
  starttls: "STARTTLS",
  plain: "None"
} satisfies Readonly<Record<EmailSecurity, string>>)

/** Label of each server's fields; a new side must add one. */
const EMAIL_SERVER_SIDE_LABELS = Object.freeze({
  imap: "IMAP server",
  smtp: "SMTP server"
} satisfies Readonly<Record<EmailServerSide, string>>)

/**
 * Label of each input as the problem summary names it, with the server of
 * a host or port; a new input must add one.
 */
const EMAIL_DRAFT_FIELD_LABELS = Object.freeze({
  address: "Address",
  displayName: "Display name",
  userName: "User name",
  password: "Password",
  imapHost: "IMAP host",
  imapPort: "IMAP port",
  smtpHost: "SMTP host",
  smtpPort: "SMTP port"
} satisfies Readonly<Record<EmailAccountDraftField, string>>)

/** Why a sign-in failed, by reason, as a clause; a new reason must add one. */
const EMAIL_SERVER_CHECK_FAILURE_TEXTS = Object.freeze({
  "wrong-password": "the user name or password was refused",
  unreachable: "the host could not be reached",
  "certificate-refused": "its certificate was refused",
  "encryption-not-offered": "it does not offer STARTTLS",
  "timed-out": "it did not answer in time",
  "protocol-error": "it answered something Lys could not read"
} satisfies Readonly<Record<EmailServerCheckFailure, string>>)

/** Why no sign-in was tried, by reason; a new reason must add one. */
const EMAIL_CHECK_UNAVAILABLE_TEXTS = Object.freeze({
  "server-missing":
    "Lys couldn't start its email server to check the account. Run build.sh to install it.",
  "server-failed": "Lys's email server failed while checking the account.",
  busy: "Another account check is still running. Try again in a minute."
} satisfies Readonly<Record<EmailAccountCheckUnavailableReason, string>>)

/** Line shown while no account is saved and nothing is edited. */
const NO_ACCOUNT_MESSAGE: EmailAccountMessage = Object.freeze({
  text: "No account yet. The email server stays off until you save one.",
  tone: "muted"
})

/** Line shown after the account and its password were saved. */
const ACCOUNT_SAVED_MESSAGE: EmailAccountMessage = Object.freeze({
  text: "Account saved.",
  tone: "success"
})

/** Line shown while the fields differ from the saved account. */
const UNSAVED_MESSAGE: EmailAccountMessage = Object.freeze({
  text: "Unsaved · Save signs in to both servers first.",
  tone: "attention"
})

/** Line shown while the fields differ and the backend is not running. */
const BACKEND_STOPPED_MESSAGE: EmailAccountMessage = Object.freeze({
  text: "Unsaved · start the backend in Settings → Runtime to sign in and save.",
  tone: "attention"
})

/** Line shown after a save was tried while a field breaks a rule. */
const INVALID_MESSAGE: EmailAccountMessage = Object.freeze({
  text: "Fix the marked fields to save.",
  tone: "danger"
})

/** Line shown while Lys signs in to the servers. */
const SIGNING_IN_MESSAGE: EmailAccountMessage = Object.freeze({
  text: "Signing in…",
  tone: "pending"
})

/** Line shown while the account is written or removed. */
const SAVING_MESSAGE: EmailAccountMessage = Object.freeze({
  text: "Saving…",
  tone: "pending"
})

/**
 * Formats the label of a way to secure a connection.
 *
 * @param security - Way to secure the connection.
 * @returns `TLS`, `STARTTLS`, or `None`.
 */
export function formatEmailSecurityLabel(security: EmailSecurity): string {
  return EMAIL_SECURITY_LABELS[security]
}

/**
 * Formats the label of one server's fields.
 *
 * @param side - Which server.
 * @returns `IMAP server` or `SMTP server`.
 */
export function formatEmailServerSideLabel(side: EmailServerSide): string {
  return EMAIL_SERVER_SIDE_LABELS[side]
}

/**
 * Lists the problem of one input of the account card.
 *
 * @param problems - First problem of each input that has one.
 * @param field - The input.
 * @returns The input with its label and problem, alone; empty while the
 * input has no problem.
 */
function listEmailDraftFieldProblem(
  problems: EmailAccountDraftProblems,
  field: EmailAccountDraftField
): readonly McpDraftProblemListing<EmailAccountDraftField>[] {
  const problem = problems[field]
  if (problem === undefined) return []
  return [{ field, label: EMAIL_DRAFT_FIELD_LABELS[field], problem }]
}

/**
 * Lists the inputs of the account card that have a problem.
 *
 * @param problems - First problem of each input that has one.
 * @returns A frozen list in the order the card shows the inputs, each with
 * its label and problem; empty for fields without problems.
 */
export function listEmailDraftProblems(
  problems: EmailAccountDraftProblems
): readonly McpDraftProblemListing<EmailAccountDraftField>[] {
  return Object.freeze(
    EMAIL_ACCOUNT_DRAFT_FIELDS.flatMap((field) =>
      listEmailDraftFieldProblem(problems, field)
    )
  )
}

/**
 * Finds the way to secure a connection a toggle group selected.
 *
 * @param groupValue - Pressed item values the toggle group reports.
 * @returns The first value when it is a way to secure a connection, or
 * undefined when none is pressed.
 */
export function findEmailSecurity(
  groupValue: readonly string[]
): EmailSecurity | undefined {
  const parsed = emailSecuritySchema.safeParse(groupValue[0])
  return parsed.success ? parsed.data : undefined
}

/**
 * Formats what the address's provider preset says about the server fields.
 *
 * @param draft - Fields as they are.
 * @returns Empty while the trimmed address is not a valid address; that
 * the address has no preset and the servers must be typed; the preset's
 * name while the server fields hold its servers; or the name with that the
 * servers were changed.
 */
export function formatEmailPresetNote(draft: EmailAccountDraft): string {
  const address = draft.address.trim()
  if (!emailAddressSchema.safeParse(address).success) return ""
  const preset = findEmailPreset(address)
  if (preset === undefined) {
    return "No preset for this address. Enter the servers."
  }
  return hasEmailPresetServers(draft, preset)
    ? `Preset: ${preset.name}`
    : `Preset: ${preset.name} · servers changed`
}

/**
 * Formats the outcome of signing in to one server.
 *
 * @param check - The server's outcome.
 * @returns `accepted`, or why the sign-in failed, as a clause.
 */
function formatEmailServerCheck(check: EmailServerCheck): string {
  return check.status === "accepted"
    ? "accepted"
    : EMAIL_SERVER_CHECK_FAILURE_TEXTS[check.reason]
}

/**
 * Formats the line of a check the backend answered.
 *
 * @param outcome - What the backend answered.
 * @returns Why no sign-in was tried, or each server's outcome, in danger
 * tone unless both servers accepted.
 */
function formatEmailCheckOutcome(
  outcome: CheckEmailAccountApiResponse
): EmailAccountMessage {
  if (outcome.status === "unavailable") {
    return {
      text: EMAIL_CHECK_UNAVAILABLE_TEXTS[outcome.reason],
      tone: "danger"
    }
  }
  const isAccepted =
    outcome.imap.status === "accepted" && outcome.smtp.status === "accepted"
  return {
    text: `IMAP: ${formatEmailServerCheck(outcome.imap)} · SMTP: ${formatEmailServerCheck(outcome.smtp)}`,
    tone: isAccepted ? "success" : "danger"
  }
}

/**
 * Formats the line of a check or save that runs.
 *
 * @param saveState - Latest save or removal.
 * @param checkState - Latest check.
 * @returns That Lys signs in or saves, or undefined while neither runs.
 */
function formatPendingMessage(
  saveState: EmailAccountSaveState,
  checkState: EmailAccountCheckState
): EmailAccountMessage | undefined {
  if (checkState.status === "checking") return SIGNING_IN_MESSAGE
  if (saveState.status === "saving") return SAVING_MESSAGE
  return undefined
}

/**
 * Answers whether the fields wait for the backend, which keeps Save
 * disabled while it is not running.
 *
 * @param input - How the fields were read, whether they differ from the
 * saved account, and the backend's status.
 * @returns True while the backend is not running and the fields hold an
 * account to save, or break a rule while they differ from the saved
 * account; false while it runs or the fields hold the saved account.
 */
function isWaitingForBackend(input: EmailAccountStatusInput): boolean {
  if (input.isBackendRunning) return false
  switch (input.draftParse.status) {
    case "changed":
      return true
    case "unchanged":
      return false
    case "invalid":
      return input.isDraftDifferent
  }
}

/**
 * Formats the line of a check that did not end in a save.
 *
 * @param checkState - Latest check.
 * @returns Why the check could not be asked, or what it found when a
 * server refused or no sign-in was tried; undefined while no check ran or
 * both servers accepted.
 */
function formatCheckMessage(
  checkState: EmailAccountCheckState
): EmailAccountMessage | undefined {
  if (checkState.status === "failed") {
    return { text: checkState.error, tone: "danger" }
  }
  if (checkState.status !== "checked") return undefined
  const checked = formatEmailCheckOutcome(checkState.outcome)
  return checked.tone === "success" ? undefined : checked
}

/**
 * Formats the line of the latest save, removal, or check, as far as it
 * still concerns the fields.
 *
 * @param input - The save, the check, and how the fields relate to them.
 * @returns While the fields were not edited since the save was tried, or
 * since the card was shown, which keeps no edit: a failed save or removal,
 * then what the check found when a server refused, no sign-in was tried,
 * or it could not be asked; undefined otherwise. The application store
 * keeps both across the card's unmounts, so a check that ended while the
 * card was not shown is reported once it is shown again.
 */
function formatOutcomeMessage(
  input: EmailAccountStatusInput
): EmailAccountMessage | undefined {
  if (input.isEditedSinceSubmit) return undefined
  if (input.saveState.status === "failed") {
    return { text: input.saveState.error, tone: "danger" }
  }
  return formatCheckMessage(input.checkState)
}

/**
 * Answers whether the latest check accepted both servers.
 *
 * @param checkState - Latest check.
 * @returns True when it ran and both servers accepted.
 */
function isCheckAccepted(checkState: EmailAccountCheckState): boolean {
  return (
    checkState.status === "checked" &&
    formatEmailCheckOutcome(checkState.outcome).tone === "success"
  )
}

/**
 * Formats the line while nothing runs, nothing is edited, and nothing
 * failed.
 *
 * @param input - Saved account, the save, and the check.
 * @returns That no account is saved; that the account was saved, after a
 * save that followed an accepted check; or the saved address.
 */
function formatRestingMessage(
  input: EmailAccountStatusInput
): EmailAccountMessage {
  if (input.savedAccount === null) return NO_ACCOUNT_MESSAGE
  if (input.saveState.status === "saved" && isCheckAccepted(input.checkState)) {
    return ACCOUNT_SAVED_MESSAGE
  }
  return { text: `Saved · ${input.savedAccount.address}`, tone: "muted" }
}

/**
 * Formats the line under the account fields.
 *
 * @param input - Saved account, the fields, the save, the check, and the
 * backend's status.
 * @returns In order of precedence: a running check or save; that the
 * backend must run, while it does not and the fields hold an account to
 * save, or break a rule while they differ from the saved account; a tried
 * save while a field breaks a rule; an edit made since the last tried save,
 * with how it is saved; a failed save or removal, or what the latest check
 * found, until the fields are edited; an unsaved edit; then whether an
 * account is saved, or that it was just saved.
 */
export function formatEmailAccountMessage(
  input: EmailAccountStatusInput
): EmailAccountMessage {
  const { draftParse } = input
  const pending = formatPendingMessage(input.saveState, input.checkState)
  if (pending !== undefined) return pending
  if (isWaitingForBackend(input)) return BACKEND_STOPPED_MESSAGE
  if (input.hasSubmitted && draftParse.status === "invalid") {
    return INVALID_MESSAGE
  }
  if (draftParse.status === "changed" && input.isEditedSinceSubmit) {
    return UNSAVED_MESSAGE
  }
  const outcome = formatOutcomeMessage(input)
  if (outcome !== undefined) return outcome
  if (draftParse.status === "changed") {
    return UNSAVED_MESSAGE
  }
  return formatRestingMessage(input)
}
