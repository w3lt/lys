import type { EmailAccount, EmailServerSettings } from "@lys/share"

/** Servers and habits of one email provider, applied by the address's domain. */
export type EmailPreset = {
  /** Provider name shown beside the fields, such as `Gmail`. */
  readonly name: string
  /** Server mail is read from. */
  readonly imap: EmailServerSettings
  /** Server mail is sent through. */
  readonly smtp: EmailServerSettings
  /** Whether the provider's SMTP server files a copy of each sent message itself. */
  readonly serverKeepsSentCopy: EmailAccount["serverKeepsSentCopy"]
}

/** Gmail and Google Workspace addresses on Google's own domains. */
const GMAIL_PRESET: EmailPreset = Object.freeze({
  name: "Gmail",
  imap: Object.freeze({ host: "imap.gmail.com", port: 993, security: "tls" }),
  smtp: Object.freeze({ host: "smtp.gmail.com", port: 465, security: "tls" }),
  serverKeepsSentCopy: true
})

/** iCloud Mail addresses, including the older me.com and mac.com domains. */
const ICLOUD_PRESET: EmailPreset = Object.freeze({
  name: "iCloud",
  imap: Object.freeze({ host: "imap.mail.me.com", port: 993, security: "tls" }),
  smtp: Object.freeze({
    host: "smtp.mail.me.com",
    port: 587,
    security: "starttls"
  }),
  serverKeepsSentCopy: false
})

/** Yahoo Mail addresses. */
const YAHOO_PRESET: EmailPreset = Object.freeze({
  name: "Yahoo",
  imap: Object.freeze({
    host: "imap.mail.yahoo.com",
    port: 993,
    security: "tls"
  }),
  smtp: Object.freeze({
    host: "smtp.mail.yahoo.com",
    port: 465,
    security: "tls"
  }),
  serverKeepsSentCopy: true
})

/** Fastmail addresses. */
const FASTMAIL_PRESET: EmailPreset = Object.freeze({
  name: "Fastmail",
  imap: Object.freeze({
    host: "imap.fastmail.com",
    port: 993,
    security: "tls"
  }),
  smtp: Object.freeze({
    host: "smtp.fastmail.com",
    port: 465,
    security: "tls"
  }),
  serverKeepsSentCopy: true
})

/**
 * Presets by the lowercase domain of the address.
 *
 * @remarks Taken from the providers' published server settings; a provider
 * that changes them needs a new entry here. Only providers that accept a
 * password or an app password over IMAP and SMTP have one: Outlook.com,
 * Hotmail, and Live accept only an OAuth sign-in there, which Lys does not
 * offer.
 */
const EMAIL_PRESETS_BY_DOMAIN: ReadonlyMap<string, EmailPreset> = new Map([
  ["gmail.com", GMAIL_PRESET],
  ["googlemail.com", GMAIL_PRESET],
  ["icloud.com", ICLOUD_PRESET],
  ["me.com", ICLOUD_PRESET],
  ["mac.com", ICLOUD_PRESET],
  ["yahoo.com", YAHOO_PRESET],
  ["fastmail.com", FASTMAIL_PRESET]
])

/**
 * Finds the preset of an address's provider.
 *
 * @param address - Email address as typed, trimmed or not.
 * @returns The preset of the domain after the last `@`, compared without
 * regard to case, or undefined when the address has no `@` or the domain
 * has no preset.
 */
export function findEmailPreset(address: string): EmailPreset | undefined {
  const separator = address.lastIndexOf("@")
  if (separator === -1) return undefined
  const domain = address
    .slice(separator + 1)
    .trim()
    .toLowerCase()
  return EMAIL_PRESETS_BY_DOMAIN.get(domain)
}
