import * as z from "zod"
import { isHostName, MAXIMUM_TCP_PORT } from "./hostName"

/**
 * Most characters an email address may have, inclusive: the longest path
 * SMTP carries.
 *
 * @remarks The settings file never holds a longer address: the desktop host
 * checks the same limit, in its own copy of this rule, when it loads the
 * file, and the email server checks it again, in a third copy, before it
 * uses the account. Raising it changes which settings files load and which
 * accounts the email server accepts, and requires a coordinated release of
 * the desktop host, the backend, and the email server.
 */
export const MAXIMUM_EMAIL_ADDRESS_LENGTH = 254

/**
 * Most characters the part of an email address before `@` may have,
 * inclusive.
 *
 * @remarks The settings file never holds a longer name: the desktop host
 * checks the same limit, in its own copy of this rule, when it loads the
 * file, and the email server checks it again, in a third copy, before it
 * uses the account. Raising it changes which settings files load and which
 * accounts the email server accepts, and requires a coordinated release of
 * the desktop host, the backend, and the email server.
 */
export const MAXIMUM_EMAIL_LOCAL_PART_LENGTH = 64

/**
 * Most characters, counted as Unicode code points, the display name of an
 * email account may have, inclusive.
 *
 * @remarks The settings file never holds a longer name: the desktop host
 * checks the same limit, in its own copy of this rule, when it loads the
 * file, and the email server checks it again, in a third copy, before it
 * uses the account. Raising it changes which settings files load and which
 * accounts the email server accepts, and requires a coordinated release of
 * the desktop host, the backend, and the email server.
 */
export const MAXIMUM_EMAIL_DISPLAY_NAME_LENGTH = 100

/**
 * Most characters, counted as Unicode code points, the user name an email
 * account signs in with may have, inclusive.
 *
 * @remarks The settings file never holds a longer name: the desktop host
 * checks the same limit, in its own copy of this rule, when it loads the
 * file, and the email server checks it again, in a third copy, before it
 * uses the account. Raising it changes which settings files load and which
 * accounts the email server accepts, and requires a coordinated release of
 * the desktop host, the backend, and the email server.
 */
export const MAXIMUM_EMAIL_USER_NAME_LENGTH = 254

/**
 * Hosts a mail server may be reached on without TLS, in lowercase: the
 * machine Lys runs on.
 *
 * @remarks A host matches in any case. The settings file never holds a
 * connection without TLS to another host: the desktop host checks the same
 * hosts, in its own copy of this rule, when it loads the file, and the
 * email server checks them again, in a third copy, before it uses the
 * account. Changing the list changes which settings files load and which
 * accounts the email server accepts, and requires a coordinated release of
 * the desktop host, the backend, and the email server.
 */
export const LOOPBACK_EMAIL_HOSTS: readonly string[] = Object.freeze([
  "localhost",
  "127.0.0.1",
  "[::1]"
])

/** The loopback hosts as a message names them: `localhost, 127.0.0.1, or [::1]`. */
const LOOPBACK_EMAIL_HOSTS_TEXT = new Intl.ListFormat("en", {
  type: "disjunction"
}).format(LOOPBACK_EMAIL_HOSTS)

/**
 * Answers whether a text is a saved text of an email account: at most a
 * number of Unicode code points, without a control character, white space
 * at either end, or a lone surrogate.
 *
 * @param value - Text to inspect, as typed.
 * @param maximumLength - Most code points allowed, inclusive.
 * @returns True when the text follows the rule; an empty text does.
 */
function isAccountText(value: string, maximumLength: number): boolean {
  /**
   * Finds a control character (Unicode general category Cc), such as a line
   * break.
   */
  const controlCharacterPattern = /\p{Cc}/u

  /** Finds white space at the start or the end of a text. */
  const edgeWhiteSpacePattern = /^\p{White_Space}|\p{White_Space}$/u

  /** Finds a lone surrogate: half of a UTF-16 pair without the other half. */
  const loneSurrogatePattern = /\p{Cs}/u

  return (
    [...value].length <= maximumLength &&
    !controlCharacterPattern.test(value) &&
    !edgeWhiteSpacePattern.test(value) &&
    !loneSurrogatePattern.test(value)
  )
}

/**
 * Answers whether a text is an email address Lys can send from and to: a
 * name of 1 to {@link MAXIMUM_EMAIL_LOCAL_PART_LENGTH} ASCII letters,
 * digits, dots, and ``! # $ % & ' * + - / = ? ^ _ ` { | } ~``, with no dot
 * at either end or two in a row, then `@` and a host name, at most
 * {@link MAXIMUM_EMAIL_ADDRESS_LENGTH} characters in all.
 *
 * @param value - Text to inspect, as typed.
 * @returns True for such an address.
 * @remarks The name is RFC 5322's dot-atom. lettre, the library the email
 * server builds its messages with, also sends from a quoted name, such as
 * `"john doe"@example.com`, and from a name with letters beyond ASCII, such
 * as `jürgen@example.com`; neither is accepted. A domain with letters beyond
 * ASCII is not accepted either: {@link isHostName} takes ASCII labels only.
 * The email server could send from an address beyond ASCII only through an
 * SMTP server that offers SMTPUTF8.
 */
function isEmailAddress(value: string): boolean {
  /**
   * Finds one atom of an email address's name, a run between its dots: ASCII
   * letters, digits, and ``! # $ % & ' * + - / = ? ^ _ ` { | } ~``.
   */
  const emailAtomPattern = /^[\w!#$%&'*+/=?^`{|}~-]+$/

  if (value.length > MAXIMUM_EMAIL_ADDRESS_LENGTH) return false
  const separator = value.lastIndexOf("@")
  if (separator <= 0) return false
  const localPart = value.slice(0, separator)
  return (
    localPart.length <= MAXIMUM_EMAIL_LOCAL_PART_LENGTH &&
    localPart.split(".").every((atom) => emailAtomPattern.test(atom)) &&
    isHostName(value.slice(separator + 1))
  )
}

/**
 * Answers whether a text names a mail server: a host name, which also
 * covers a dotted IPv4 address, or an IPv6 address in brackets.
 *
 * @param value - Text to inspect, as typed.
 * @returns True for such a host.
 */
function isEmailHost(value: string): boolean {
  /** Most characters an IPv6 address in brackets may have, inclusive. */
  const maximumBracketedIpv6Length = 47

  /**
   * Finds an IPv6 address in brackets: hexadecimal digits, colons, and the
   * dots of an embedded IPv4 address, with at least one colon.
   */
  const bracketedIpv6Pattern = /^\[[0-9A-Fa-f.]*:[0-9A-Fa-f:.]*\]$/

  if (isHostName(value)) return true
  return (
    value.length <= maximumBracketedIpv6Length &&
    bracketedIpv6Pattern.test(value)
  )
}

/**
 * Answers whether a mail server host is the machine Lys runs on, which it
 * may be reached on without TLS.
 *
 * @param host - Host as typed, which may have failed the mail server host
 * rule.
 * @returns True for `localhost`, `127.0.0.1`, or `[::1]`, in any case.
 */
function isLoopbackEmailHost(host: string): boolean {
  return LOOPBACK_EMAIL_HOSTS.includes(host.toLowerCase())
}

/**
 * Validates the address of an email account, as the person typed it.
 *
 * @remarks The rule matches the desktop host's `EmailAddress`. Parsing
 * never trims or changes the address. The address is personal data.
 */
export const emailAddressSchema = z
  .string()
  .refine(
    isEmailAddress,
    `An email address is a name of 1 to ${MAXIMUM_EMAIL_LOCAL_PART_LENGTH} ASCII letters, digits, dots, and ! # $ % & ' * + - / = ? ^ _ \` { | } ~, with no dot at either end or two in a row, then @ and an ASCII host name, up to ${MAXIMUM_EMAIL_ADDRESS_LENGTH} characters in all.`
  )

/**
 * Validates the display name sent with an email account's address; empty
 * sends the address alone.
 *
 * @remarks Matches the desktop host's rule. The name is personal data.
 */
const emailDisplayNameSchema = z
  .string()
  .refine(
    (value) => isAccountText(value, MAXIMUM_EMAIL_DISPLAY_NAME_LENGTH),
    `A display name is up to ${MAXIMUM_EMAIL_DISPLAY_NAME_LENGTH} characters, without line breaks or other control characters, and without spaces at either end.`
  )

/**
 * Validates the user name an email account signs in to its servers with,
 * often the address itself.
 *
 * @remarks Matches the desktop host's rule. The name is personal data.
 */
const emailUserNameSchema = z
  .string()
  .min(1, "A user name is required.")
  .refine(
    (value) => isAccountText(value, MAXIMUM_EMAIL_USER_NAME_LENGTH),
    `A user name is up to ${MAXIMUM_EMAIL_USER_NAME_LENGTH} characters, without line breaks or other control characters, and without spaces at either end.`
  )

/**
 * Validates how Lys secures its connection to a mail server: `tls` connects
 * with TLS from the first byte, `starttls` connects in plain text and then
 * upgrades with STARTTLS, which Lys requires to succeed, and `plain` never
 * encrypts, which only a loopback host may use.
 *
 * @remarks The desktop host declares the same three values. Adding one is
 * a compatibility change for every consumer that branches on it.
 */
export const emailSecuritySchema = z.enum(["tls", "starttls", "plain"])

/** How Lys secures its connection to a mail server. */
export type EmailSecurity = z.infer<typeof emailSecuritySchema>

/**
 * Answers whether a mail server's host may be reached with its security.
 *
 * @param server - The server's host as typed, which may have failed the
 * host rule, and its security.
 * @returns True for TLS or STARTTLS to any host, and for a connection
 * without TLS to `localhost`, `127.0.0.1`, or `[::1]`.
 */
function isSecurityAllowed(
  server: Readonly<{ host: string; security: EmailSecurity }>
): boolean {
  switch (server.security) {
    case "tls":
    case "starttls":
      return true
    case "plain":
      return isLoopbackEmailHost(server.host)
  }
}

/**
 * Validates one mail server of an email account: its host, port, and how
 * the connection is secured. The output is frozen; unknown fields are
 * rejected.
 *
 * @remarks `plain` is accepted only for `localhost`, `127.0.0.1`, or
 * `[::1]`; every other host is reached with TLS, whose certificate the
 * operating system verifies.
 */
const emailServerSettingsSchema = z
  .strictObject({
    /** Host name, dotted IPv4 address, or IPv6 address in brackets. */
    host: z
      .string()
      .refine(
        isEmailHost,
        "A mail server host is an ASCII host name, an IPv4 address, or an IPv6 address in brackets."
      ),
    /** TCP port, such as 993 for IMAP or 465 for SMTP over TLS. */
    port: z.int().min(1).max(MAXIMUM_TCP_PORT),
    /** How the connection is secured. */
    security: emailSecuritySchema
  })
  .refine(
    isSecurityAllowed,
    `A connection without TLS is allowed only to ${LOOPBACK_EMAIL_HOSTS_TEXT}.`
  )
  .readonly()

/** One mail server of an email account. */
export type EmailServerSettings = z.infer<typeof emailServerSettingsSchema>

/**
 * Validates the email account Lys's email server works with: who the
 * person is, how it signs in, and the servers it reaches. The output is
 * frozen; unknown fields are rejected.
 *
 * @remarks The password is not here: it lives in the `secrets` group as
 * `emailPassword`. The account is personal data.
 */
export const emailAccountSchema = z
  .strictObject({
    /** Address mail is sent from and received at. */
    address: emailAddressSchema,
    /** Name sent with the address; empty sends the address alone. */
    displayName: emailDisplayNameSchema,
    /** Name the account signs in with. */
    userName: emailUserNameSchema,
    /** Server mail is read from. */
    imap: emailServerSettingsSchema,
    /** Server mail is sent through. */
    smtp: emailServerSettingsSchema,
    /**
     * Whether the SMTP server files a copy of each sent message in the Sent
     * folder itself, as Gmail does; when false, Lys files the copy.
     */
    serverKeepsSentCopy: z.boolean()
  })
  .readonly()

/** The email account as the `email` settings group holds it. */
export type EmailAccount = z.infer<typeof emailAccountSchema>

/** Email account before validation. */
export type EmailAccountCandidate = z.input<typeof emailAccountSchema>

/**
 * Folds the ASCII letters of a text to lowercase and keeps every other
 * character, as Rust's `eq_ignore_ascii_case` compares texts.
 *
 * @param text - Text to fold.
 * @returns The folded text.
 */
function foldAsciiCase(text: string): string {
  return text.replaceAll(/[A-Z]/g, (letter) => letter.toLowerCase())
}

/**
 * Answers whether two email accounts sign in to the same mailbox: the same
 * address, or the same user name on the same IMAP host and port, with texts
 * compared without regard to ASCII case.
 *
 * @param first - One account.
 * @param second - The other account.
 * @returns True when the accounts are one mailbox.
 * @remarks The desktop host checks the same rule, in its own copy, when it
 * loads the settings file, and the email server checks it again, in a third
 * copy, before it serves two mailboxes. Changing it changes which settings
 * files load and requires a coordinated release of the desktop host, the
 * backend, and the email server.
 */
export function isSameEmailMailbox(
  first: EmailAccount,
  second: EmailAccount
): boolean {
  if (foldAsciiCase(first.address) === foldAsciiCase(second.address))
    return true
  return (
    foldAsciiCase(first.userName) === foldAsciiCase(second.userName) &&
    foldAsciiCase(first.imap.host) === foldAsciiCase(second.imap.host) &&
    first.imap.port === second.imap.port
  )
}

/**
 * Answers whether the accounts of an `email` group are distinct mailboxes:
 * true when either account is missing.
 *
 * @param group - The group's two accounts, each already valid.
 * @returns False when both accounts are saved and are one mailbox.
 */
function hasDistinctMailboxes(
  group: Readonly<{
    account: EmailAccount | null
    lysAccount: EmailAccount | null
  }>
): boolean {
  if (group.account === null || group.lysAccount === null) return true
  return !isSameEmailMailbox(group.account, group.lysAccount)
}

/**
 * Validates the `email` settings group: the person's email account and
 * Lys's own, each saved or `null`. The output is frozen; unknown fields are
 * rejected.
 *
 * @remarks An omitted account means none. The two accounts may not be one
 * mailbox, as {@link isSameEmailMailbox} tells. The desktop host is the only
 * writer of the group; the backend only reads it.
 */
export const emailSettingsSchema = z
  .strictObject({
    /** The person's saved account; `null` when none is saved. */
    account: emailAccountSchema.nullable().default(null),
    /** Lys's own saved account; `null` when none is saved. */
    lysAccount: emailAccountSchema.nullable().default(null)
  })
  .refine(
    hasDistinctMailboxes,
    "Lys's email account must be a mailbox of its own: an address other than the person's, and not the person's user name on the same IMAP host and port."
  )
  .readonly()

/** The `email` settings group. */
export type EmailSettings = z.infer<typeof emailSettingsSchema>
