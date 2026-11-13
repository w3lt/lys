import { emailPasswordSchema, type EmailAccount } from "@lys/share"
import { describe, expect, it } from "vitest"
import {
  buildEmailAccountDraft,
  EMAIL_ACCOUNT_DRAFT_FIELDS,
  hasEmailPresetServers,
  isEmailAccountDraftDifferent,
  parseEmailAccountDraft,
  updateEmailAccountAddress,
  type EmailAccountDraft,
  type EmailAccountDraftBasis,
  type EmailServerDraft
} from "@/lib/models/email-account-draft"
import { findEmailPreset } from "@/lib/models/email-presets"
import {
  LYS_EMAIL_ACCOUNT,
  STORED_EMAIL_ACCOUNT,
  STORED_EMAIL_PASSWORD
} from "../../support/settingsFixtures"
import { listKeystrokeTexts } from "../../support/typing"

/** A change to a typed draft that breaks one field's rule. */
type DraftFieldProblem = {
  /** Fields replacing the typed Gmail draft's. */
  readonly change: Partial<EmailAccountDraft>
  /** Field whose input reports the problem. */
  readonly field: string
  /** Text the reported problem contains. */
  readonly expectedProblem: string
}

/** The fields showing the stored account. */
const SAVED_DRAFT = buildEmailAccountDraft(STORED_EMAIL_ACCOUNT, "person")

/** The fields of an empty card. */
const EMPTY_DRAFT = buildEmailAccountDraft(null, "person")

/** What the person's card reads its fields against while nothing is saved. */
const NEW_PERSON_BASIS: EmailAccountDraftBasis = Object.freeze({
  mailbox: "person",
  savedAccount: null,
  savedPassword: null,
  otherAccount: null
})

/** What the person's card reads its fields against with the stored account. */
const SAVED_PERSON_BASIS: EmailAccountDraftBasis = Object.freeze({
  mailbox: "person",
  savedAccount: STORED_EMAIL_ACCOUNT,
  savedPassword: STORED_EMAIL_PASSWORD,
  otherAccount: null
})

/** Preset of the stored account's provider. */
const FASTMAIL = findEmailPreset(STORED_EMAIL_ACCOUNT.address)

/** The saved IMAP server with a host of the person's own. */
const SAVED_IMAP_ON_OWN_HOST: EmailServerDraft = Object.freeze({
  ...SAVED_DRAFT.imap,
  host: "mail.example.test"
})

/** The saved SMTP server secured with STARTTLS. */
const SAVED_SMTP_WITH_STARTTLS: EmailServerDraft = Object.freeze({
  ...SAVED_DRAFT.smtp,
  security: "starttls"
})

/**
 * Updates the address one keystroke at a time, as the card does while the
 * person types: Backspace down to the start both addresses share, then each
 * character of the rest.
 *
 * @param draft - Fields before the first keystroke.
 * @param address - Address the fields hold afterwards.
 * @returns The fields after the last keystroke.
 */
function updateAddressByKeystroke(
  draft: EmailAccountDraft,
  address: string
): EmailAccountDraft {
  return listKeystrokeTexts(draft.address, address).reduce(
    (typed, text) => updateEmailAccountAddress(typed, text),
    draft
  )
}

/**
 * Builds the fields of a Gmail account typed from scratch.
 *
 * @returns The empty draft with a Gmail address, its preset applied, a
 * display name, a user name, and a password.
 */
function buildTypedGmailDraft(): EmailAccountDraft {
  return {
    ...updateEmailAccountAddress(EMPTY_DRAFT, "ada@gmail.com"),
    displayName: "Ada",
    userName: "ada@gmail.com",
    password: "app-password"
  }
}

describe("EMAIL_ACCOUNT_DRAFT_FIELDS", () => {
  it("lists every input in the card's order", () => {
    expect(EMAIL_ACCOUNT_DRAFT_FIELDS).toEqual([
      "address",
      "displayName",
      "userName",
      "password",
      "imapHost",
      "imapPort",
      "smtpHost",
      "smtpPort"
    ])
  })
})

describe("buildEmailAccountDraft", () => {
  it("shows the saved account with the ports as text, the password field empty, and its address's preset as the applied one", () => {
    expect(SAVED_DRAFT).toEqual({
      address: "ada@fastmail.com",
      displayName: "Ada Fixture",
      userName: "ada@fastmail.com",
      password: "",
      imap: { host: "imap.fastmail.com", port: "993", security: "tls" },
      smtp: { host: "smtp.fastmail.com", port: "465", security: "tls" },
      serverKeepsSentCopy: true,
      appliedPreset: FASTMAIL
    })
  })

  it("shows an empty card with TLS on both servers and Lys filing the Sent copy", () => {
    expect(EMPTY_DRAFT).toEqual({
      address: "",
      displayName: "",
      userName: "",
      password: "",
      imap: { host: "", port: "", security: "tls" },
      smtp: { host: "", port: "", security: "tls" },
      serverKeepsSentCopy: false
    })
  })

  it("starts an empty card of Lys's mailbox with her name as the display name", () => {
    expect(buildEmailAccountDraft(null, "lys")).toEqual({
      ...EMPTY_DRAFT,
      displayName: "Lys"
    })
    expect(isEmailAccountDraftDifferent(EMPTY_DRAFT, null, "lys")).toBe(true)
  })
})

describe("hasEmailPresetServers", () => {
  /** The saved SMTP server on port 587. */
  const savedSmtpOnPort587: EmailServerDraft = Object.freeze({
    ...SAVED_DRAFT.smtp,
    port: "587"
  })

  it("is true while both servers equal the preset's", () => {
    if (FASTMAIL === undefined) throw new Error("No Fastmail preset")

    expect(hasEmailPresetServers(SAVED_DRAFT, FASTMAIL)).toBe(true)
  })

  it.each([
    ["the IMAP host", { imap: SAVED_IMAP_ON_OWN_HOST }],
    ["a port", { smtp: savedSmtpOnPort587 }],
    ["the security", { smtp: SAVED_SMTP_WITH_STARTTLS }]
  ] as const)("is false once %s differs", (_label, change) => {
    if (FASTMAIL === undefined) throw new Error("No Fastmail preset")

    expect(hasEmailPresetServers({ ...SAVED_DRAFT, ...change }, FASTMAIL)).toBe(
      false
    )
  })
})

describe("updateEmailAccountAddress", () => {
  it("fills empty server fields and the Sent copy from the address's preset, and records it as the applied one", () => {
    /** Preset of an iCloud address. */
    const icloudPreset = findEmailPreset("ada@icloud.com")

    expect(updateEmailAccountAddress(EMPTY_DRAFT, "ada@icloud.com")).toEqual({
      ...EMPTY_DRAFT,
      address: "ada@icloud.com",
      imap: { host: "imap.mail.me.com", port: "993", security: "tls" },
      smtp: { host: "smtp.mail.me.com", port: "587", security: "starttls" },
      serverKeepsSentCopy: false,
      appliedPreset: icloudPreset
    })
  })

  it("replaces the servers of the preset that filled them when the address changes to another provider's at once", () => {
    const gmail = updateEmailAccountAddress(EMPTY_DRAFT, "ada@gmail.com")

    expect(updateEmailAccountAddress(gmail, "ada@icloud.com")).toMatchObject({
      address: "ada@icloud.com",
      imap: { host: "imap.mail.me.com" },
      smtp: {
        host: "smtp.mail.me.com",
        port: "587",
        security: "starttls"
      },
      serverKeepsSentCopy: false
    })
  })

  it("keeps server fields the person typed", () => {
    const imap: EmailServerDraft = {
      host: "mail.example.test",
      port: "993",
      security: "tls"
    }
    const typed: EmailAccountDraft = { ...EMPTY_DRAFT, imap }

    expect(updateEmailAccountAddress(typed, "ada@gmail.com")).toEqual({
      ...typed,
      address: "ada@gmail.com"
    })
  })

  it("keeps a port and a security the person chose before the hosts", () => {
    const imap: EmailServerDraft = {
      host: "",
      port: "1993",
      security: "starttls"
    }
    const chosen: EmailAccountDraft = { ...EMPTY_DRAFT, imap }

    expect(updateEmailAccountAddress(chosen, "ada@gmail.com")).toEqual({
      ...chosen,
      address: "ada@gmail.com"
    })
  })

  it("keeps a Sent-copy choice the person made before the address", () => {
    const chosen: EmailAccountDraft = {
      ...EMPTY_DRAFT,
      serverKeepsSentCopy: true
    }

    expect(updateEmailAccountAddress(chosen, "ada@icloud.com")).toEqual({
      ...chosen,
      address: "ada@icloud.com"
    })
  })

  it("keeps a Sent-copy choice the person changed after the preset filled it", () => {
    const gmail = updateEmailAccountAddress(EMPTY_DRAFT, "ad@gmail.com")
    const changed = { ...gmail, serverKeepsSentCopy: false }

    expect(updateEmailAccountAddress(changed, "ada@gmail.com")).toEqual({
      ...changed,
      address: "ada@gmail.com"
    })
  })

  it("keeps the servers of a preset the person changed", () => {
    const gmail = updateEmailAccountAddress(EMPTY_DRAFT, "ada@gmail.com")
    const smtp: EmailServerDraft = { ...gmail.smtp, port: "587" }
    const changed: EmailAccountDraft = { ...gmail, smtp }

    expect(updateEmailAccountAddress(changed, "ada@yahoo.com")).toEqual({
      ...changed,
      address: "ada@yahoo.com"
    })
  })

  it("changes only the address when the provider has no preset", () => {
    expect(updateEmailAccountAddress(EMPTY_DRAFT, "ada@example.test")).toEqual({
      ...EMPTY_DRAFT,
      address: "ada@example.test"
    })
  })

  it("replaces saved servers that hold the saved address's preset when the address changes to another provider's at once", () => {
    /** Preset of a Gmail address. */
    const gmailPreset = findEmailPreset("ada@gmail.com")

    expect(updateEmailAccountAddress(SAVED_DRAFT, "ada@gmail.com")).toEqual({
      ...SAVED_DRAFT,
      address: "ada@gmail.com",
      imap:
        gmailPreset === undefined
          ? undefined
          : { ...gmailPreset.imap, port: "993" },
      smtp:
        gmailPreset === undefined
          ? undefined
          : { ...gmailPreset.smtp, port: "465" },
      appliedPreset: gmailPreset
    })
  })

  it("keeps a typed address that has no preset yet while typing", () => {
    expect(updateEmailAccountAddress(EMPTY_DRAFT, "ada@gma")).toEqual({
      ...EMPTY_DRAFT,
      address: "ada@gma"
    })
  })

  it("replaces the Gmail preset with Fastmail's once the address is retyped one character at a time", () => {
    const gmail = updateAddressByKeystroke(EMPTY_DRAFT, "ada@gmail.com")

    expect(updateAddressByKeystroke(gmail, "ada@fastmail.com")).toMatchObject({
      address: "ada@fastmail.com",
      imap: { host: "imap.fastmail.com", port: "993", security: "tls" },
      smtp: { host: "smtp.fastmail.com", port: "465", security: "tls" },
      serverKeepsSentCopy: true
    })
  })

  it("replaces the iCloud preset with Gmail's, its Sent copy included, once the address is retyped one character at a time", () => {
    const icloud = updateAddressByKeystroke(EMPTY_DRAFT, "ada@icloud.com")

    expect(updateAddressByKeystroke(icloud, "ada@gmail.com")).toMatchObject({
      address: "ada@gmail.com",
      imap: { host: "imap.gmail.com", port: "993", security: "tls" },
      smtp: { host: "smtp.gmail.com", port: "465", security: "tls" },
      serverKeepsSentCopy: true
    })
  })

  it("keeps a filled preset through an address without one, then replaces it with the next address's preset", () => {
    const gmail = updateAddressByKeystroke(EMPTY_DRAFT, "ada@gmail.com")
    const noPreset = updateAddressByKeystroke(gmail, "ada@example.test")

    expect(noPreset).toEqual({ ...gmail, address: "ada@example.test" })
    expect(
      updateAddressByKeystroke(noPreset, "ada@fastmail.com")
    ).toMatchObject({
      imap: { host: "imap.fastmail.com", port: "993", security: "tls" },
      smtp: { host: "smtp.fastmail.com", port: "465", security: "tls" },
      serverKeepsSentCopy: true
    })
  })

  it("replaces saved servers that hold the saved address's preset once another provider's address is typed one character at a time", () => {
    expect(
      updateAddressByKeystroke(SAVED_DRAFT, "ada@gmail.com")
    ).toMatchObject({
      address: "ada@gmail.com",
      imap: { host: "imap.gmail.com", port: "993", security: "tls" },
      smtp: { host: "smtp.gmail.com", port: "465", security: "tls" },
      serverKeepsSentCopy: true
    })
  })

  it("keeps servers the person changed after a preset filled them while another provider's address is typed", () => {
    const gmail = updateAddressByKeystroke(EMPTY_DRAFT, "ada@gmail.com")
    const changedSmtp: EmailServerDraft = { ...gmail.smtp, port: "587" }
    const changed: EmailAccountDraft = { ...gmail, smtp: changedSmtp }

    expect(updateAddressByKeystroke(changed, "ada@fastmail.com")).toEqual({
      ...changed,
      address: "ada@fastmail.com"
    })
  })

  it("keeps servers the person typed that equal another provider's preset when the address moves to a provider with a preset", () => {
    /**
     * Fastmail's IMAP server, as the person types it for a domain of their own.
     */
    const typedFastmailImap: EmailServerDraft = Object.freeze({
      host: "imap.fastmail.com",
      port: "993",
      security: "tls"
    })

    /**
     * Fastmail's SMTP server, as the person types it for a domain of their own.
     */
    const typedFastmailSmtp: EmailServerDraft = Object.freeze({
      host: "smtp.fastmail.com",
      port: "465",
      security: "tls"
    })

    const typed: EmailAccountDraft = {
      ...EMPTY_DRAFT,
      address: "ada@example.test",
      imap: typedFastmailImap,
      smtp: typedFastmailSmtp,
      serverKeepsSentCopy: true
    }

    expect(updateAddressByKeystroke(typed, "ada@gmail.com")).toEqual({
      ...typed,
      address: "ada@gmail.com"
    })
  })

  it("keeps the saved servers of an address without a preset, also when they equal another provider's preset", () => {
    const ownDomain: EmailAccount = {
      ...STORED_EMAIL_ACCOUNT,
      address: "ada@example.test"
    }
    const saved = buildEmailAccountDraft(ownDomain, "person")

    expect(updateAddressByKeystroke(saved, "ada@gmail.com")).toEqual({
      ...saved,
      address: "ada@gmail.com"
    })
  })
})

describe("parseEmailAccountDraft", () => {
  /** Problem of an address that breaks the address rule. */
  const addressProblem =
    "An email address is a name of 1 to 64 ASCII letters, digits, dots, and ! # $ % & ' * + - / = ? ^ _ ` { | } ~, with no dot at either end or two in a row, then @ and an ASCII host name, up to 254 characters in all."

  /** Problem of a mail server host that breaks the host rule. */
  const hostProblem =
    "A mail server host is an ASCII host name, an IPv4 address, or an IPv6 address in brackets."

  /** Gmail's IMAP server with a space in its host. */
  const spacedHostImap: EmailServerDraft = Object.freeze({
    host: "mail server",
    port: "993",
    security: "tls"
  })

  /** An IMAP server whose host holds a letter beyond ASCII. */
  const nonAsciiHostImap: EmailServerDraft = Object.freeze({
    host: "imap.bücher.example",
    port: "993",
    security: "tls"
  })

  /** Gmail's SMTP server on a port above 65535. */
  const outOfRangePortSmtp: EmailServerDraft = Object.freeze({
    host: "smtp.gmail.com",
    port: "70000",
    security: "tls"
  })

  /** Gmail's SMTP server on a port with a letter in it. */
  const letteredPortSmtp: EmailServerDraft = Object.freeze({
    host: "smtp.gmail.com",
    port: "25a",
    security: "tls"
  })

  /** Gmail's IMAP server on port zero. */
  const zeroPortImap: EmailServerDraft = Object.freeze({
    host: "imap.gmail.com",
    port: "0",
    security: "tls"
  })

  it("reads the saved account with an empty password field as unchanged", () => {
    expect(parseEmailAccountDraft(SAVED_DRAFT, SAVED_PERSON_BASIS)).toEqual({
      status: "unchanged"
    })
  })

  it("reads a typed account as changed, trimmed, with the ports as numbers", () => {
    const imap: EmailServerDraft = {
      host: " imap.gmail.com ",
      port: " 993 ",
      security: "tls"
    }
    const typed: EmailAccountDraft = {
      ...buildTypedGmailDraft(),
      address: " ada@gmail.com ",
      displayName: " Ada ",
      imap
    }

    expect(parseEmailAccountDraft(typed, NEW_PERSON_BASIS)).toEqual({
      status: "changed",
      account: {
        address: "ada@gmail.com",
        displayName: "Ada",
        userName: "ada@gmail.com",
        imap: { host: "imap.gmail.com", port: 993, security: "tls" },
        smtp: { host: "smtp.gmail.com", port: 465, security: "tls" },
        serverKeepsSentCopy: true
      },
      password: "app-password"
    })
  })

  it("reads a typed password for the saved account as changed, with the saved account", () => {
    expect(
      parseEmailAccountDraft(
        { ...SAVED_DRAFT, password: "new-app-password" },
        SAVED_PERSON_BASIS
      )
    ).toEqual({
      status: "changed",
      account: STORED_EMAIL_ACCOUNT,
      password: "new-app-password"
    })
  })

  it("keeps the saved password when the field is empty and a field changed", () => {
    expect(
      parseEmailAccountDraft(
        { ...SAVED_DRAFT, serverKeepsSentCopy: false },
        SAVED_PERSON_BASIS
      )
    ).toEqual({
      status: "changed",
      account: { ...STORED_EMAIL_ACCOUNT, serverKeepsSentCopy: false },
      password: STORED_EMAIL_PASSWORD
    })
  })

  it.each<[string, DraftFieldProblem]>([
    [
      "an address",
      {
        change: { address: "ada" },
        field: "address",
        expectedProblem: "address"
      }
    ],
    [
      "an address whose name holds a letter beyond ASCII",
      {
        change: { address: "josé@example.test" },
        field: "address",
        expectedProblem: addressProblem
      }
    ],
    [
      "an address whose name has two dots in a row",
      {
        change: { address: "ada..lovelace@example.test" },
        field: "address",
        expectedProblem: addressProblem
      }
    ],
    [
      "an address whose name is over 64 characters",
      {
        change: { address: `${"a".repeat(65)}@example.test` },
        field: "address",
        expectedProblem: addressProblem
      }
    ],
    [
      "an address whose host holds a letter beyond ASCII",
      {
        change: { address: "ada@bücher.example" },
        field: "address",
        expectedProblem: addressProblem
      }
    ],
    [
      "a display name over the limit",
      {
        change: { displayName: "a".repeat(201) },
        field: "displayName",
        expectedProblem: "display name"
      }
    ],
    [
      "an empty user name",
      {
        change: { userName: "" },
        field: "userName",
        expectedProblem: "user name"
      }
    ],
    [
      "a host",
      {
        change: { imap: spacedHostImap },
        field: "imapHost",
        expectedProblem: "host"
      }
    ],
    [
      "a host that holds a letter beyond ASCII",
      {
        change: { imap: nonAsciiHostImap },
        field: "imapHost",
        expectedProblem: hostProblem
      }
    ],
    [
      "a port that is not a whole number in range",
      {
        change: { smtp: outOfRangePortSmtp },
        field: "smtpPort",
        expectedProblem: "A port is a whole number from 1 to 65535."
      }
    ],
    [
      "a port with letters",
      {
        change: { smtp: letteredPortSmtp },
        field: "smtpPort",
        expectedProblem: "A port is a whole number from 1 to 65535."
      }
    ],
    [
      "a port of zero",
      {
        change: { imap: zeroPortImap },
        field: "imapPort",
        expectedProblem: "A port is a whole number from 1 to 65535."
      }
    ],
    [
      "a password with a line break",
      {
        change: { password: "app\npassword" },
        field: "password",
        expectedProblem:
          "A password is 1 to 1024 characters, without line breaks or other control characters."
      }
    ]
  ])(
    "reports %s under its input",
    (_label, { change, field, expectedProblem }) => {
      const parse = parseEmailAccountDraft(
        { ...buildTypedGmailDraft(), ...change },
        NEW_PERSON_BASIS
      )

      expect(parse.status).toBe("invalid")
      if (parse.status !== "invalid") return
      expect(Object.keys(parse.problems)).toEqual([field])
      expect(parse.problems[field as keyof typeof parse.problems]).toContain(
        expectedProblem
      )
    }
  )

  it("places a connection without TLS to another machine on that server's host", () => {
    const smtp: EmailServerDraft = {
      host: "smtp.gmail.com",
      port: "25",
      security: "plain"
    }

    const parse = parseEmailAccountDraft(
      { ...buildTypedGmailDraft(), smtp },
      NEW_PERSON_BASIS
    )

    expect(parse).toEqual({
      status: "invalid",
      problems: {
        smtpHost:
          "A connection without TLS is allowed only to localhost, 127.0.0.1, or [::1]."
      }
    })
  })

  it("allows a connection without TLS to this machine", () => {
    const imap: EmailServerDraft = {
      host: "localhost",
      port: "143",
      security: "plain"
    }

    const parse = parseEmailAccountDraft(
      { ...buildTypedGmailDraft(), imap },
      NEW_PERSON_BASIS
    )

    expect(parse).toMatchObject({
      status: "changed",
      account: { imap: { host: "localhost", port: 143, security: "plain" } }
    })
  })

  it("asks for the password while none is saved", () => {
    expect(
      parseEmailAccountDraft(
        { ...buildTypedGmailDraft(), password: "" },
        NEW_PERSON_BASIS
      )
    ).toEqual({
      status: "invalid",
      problems: { password: "Enter the password." }
    })
  })

  it("reports the first problem of every input, in the card's order", () => {
    const parse = parseEmailAccountDraft(
      { ...EMPTY_DRAFT, address: "ada", userName: "ada" },
      NEW_PERSON_BASIS
    )

    expect(parse.status).toBe("invalid")
    if (parse.status !== "invalid") return
    expect(Object.keys(parse.problems)).toEqual([
      "address",
      "imapHost",
      "imapPort",
      "smtpHost",
      "smtpPort",
      "password"
    ])
  })

  it("reads the password as typed, keeping its spaces", () => {
    const parse = parseEmailAccountDraft(
      { ...buildTypedGmailDraft(), password: " app password " },
      NEW_PERSON_BASIS
    )

    expect(parse).toMatchObject({
      status: "changed",
      password: " app password "
    })
  })

  it("brands the password it returns", () => {
    const parse = parseEmailAccountDraft(
      buildTypedGmailDraft(),
      NEW_PERSON_BASIS
    )

    expect(parse.status).toBe("changed")
    if (parse.status !== "changed") return
    expect(emailPasswordSchema.safeParse(parse.password).success).toBe(true)
  })

  it("treats a saved account whose provider changed as changed", () => {
    const moved: EmailAccount = {
      ...STORED_EMAIL_ACCOUNT,
      address: "ada@gmail.com"
    }

    expect(
      parseEmailAccountDraft(
        { ...SAVED_DRAFT, address: "ada@gmail.com" },
        SAVED_PERSON_BASIS
      )
    ).toEqual({
      status: "changed",
      account: moved,
      password: STORED_EMAIL_PASSWORD
    })
  })
})

describe("parseEmailAccountDraft of an account that opens the other mailbox", () => {
  /** A typed password, so that only the mailbox can keep a draft from saving. */
  const password = "app-password"

  /** Lys's card, empty, while the person's stored account is saved. */
  const lysBasis: EmailAccountDraftBasis = Object.freeze({
    mailbox: "lys",
    savedAccount: null,
    savedPassword: null,
    otherAccount: STORED_EMAIL_ACCOUNT
  })

  /** The person's card, empty, while Lys's account is saved. */
  const personBasis: EmailAccountDraftBasis = Object.freeze({
    ...NEW_PERSON_BASIS,
    otherAccount: LYS_EMAIL_ACCOUNT
  })

  /** What Lys's card says of the person's address and sign-in. */
  const lysProblems = Object.freeze({
    address:
      "This is the address of your own account. Lys needs an address of her own.",
    userName:
      "This signs in to your own mailbox. Lys needs a mailbox of her own."
  })

  it.each([
    [
      "Lys's card, the person's address and sign-in",
      lysBasis,
      { ...SAVED_DRAFT, password },
      lysProblems
    ],
    [
      "Lys's card, the person's address in other case",
      lysBasis,
      {
        ...SAVED_DRAFT,
        address: "ADA@fastmail.com",
        userName: "lys@fastmail.com",
        password
      },
      { address: lysProblems.address }
    ],
    [
      "Lys's card, the person's sign-in",
      lysBasis,
      { ...SAVED_DRAFT, address: "lys@fastmail.com", password },
      { userName: lysProblems.userName }
    ],
    [
      "the person's card, Lys's address and sign-in",
      personBasis,
      { ...buildEmailAccountDraft(LYS_EMAIL_ACCOUNT, "person"), password },
      {
        address: "This is the address of Lys's account.",
        userName: "This signs in to Lys's mailbox."
      }
    ]
  ] as const)("refuses, on %s", (_label, basis, draft, problems) => {
    expect(parseEmailAccountDraft(draft, basis)).toEqual({
      status: "invalid",
      problems
    })
  })

  it("accepts the same user name on another IMAP server", () => {
    const imap: EmailServerDraft = { ...SAVED_DRAFT.imap, port: "143" }

    expect(
      parseEmailAccountDraft(
        { ...SAVED_DRAFT, address: "lys@fastmail.com", imap, password },
        lysBasis
      )
    ).toMatchObject({ status: "changed" })
  })
})

describe("isEmailAccountDraftDifferent", () => {
  it.each([
    ["the saved account's fields", SAVED_DRAFT, STORED_EMAIL_ACCOUNT],
    ["the fields of an empty card without an account", EMPTY_DRAFT, null]
  ] as const)("is false for %s", (_label, draft, savedAccount) => {
    expect(isEmailAccountDraftDifferent(draft, savedAccount, "person")).toBe(
      false
    )
  })

  it.each<[string, Partial<EmailAccountDraft>]>([
    ["a space is typed after the address", { address: "ada@fastmail.com " }],
    ["the display name changes", { displayName: "Ada Lovelace" }],
    ["the user name is emptied", { userName: "" }],
    ["a password is typed", { password: "app-password" }],
    ["the IMAP host changes", { imap: SAVED_IMAP_ON_OWN_HOST }],
    ["the SMTP security changes", { smtp: SAVED_SMTP_WITH_STARTTLS }],
    ["the Sent copy switch changes", { serverKeepsSentCopy: false }]
  ])("is true once %s in the saved account's fields", (_label, change) => {
    expect(
      isEmailAccountDraftDifferent(
        { ...SAVED_DRAFT, ...change },
        STORED_EMAIL_ACCOUNT,
        "person"
      )
    ).toBe(true)
  })

  it("is true once anything is typed in an empty card", () => {
    expect(
      isEmailAccountDraftDifferent(
        { ...EMPTY_DRAFT, userName: "ada" },
        null,
        "person"
      )
    ).toBe(true)
  })
})
