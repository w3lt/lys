import { emailPasswordSchema, type EmailAccount } from "@lys/share"
import { describe, expect, it } from "vitest"
import {
  buildEmailAccountDraft,
  EMAIL_ACCOUNT_DRAFT_FIELDS,
  hasEmailPresetServers,
  parseEmailAccountDraft,
  updateEmailAccountAddress,
  type EmailAccountDraft
} from "@/lib/models/email-account-draft"
import { findEmailPreset } from "@/lib/models/email-presets"
import {
  STORED_EMAIL_ACCOUNT,
  STORED_EMAIL_PASSWORD
} from "../../support/settingsFixtures"

/** The fields showing the stored account. */
const SAVED_DRAFT = buildEmailAccountDraft(STORED_EMAIL_ACCOUNT)

/** The fields of an empty card. */
const EMPTY_DRAFT = buildEmailAccountDraft(null)

/** Preset of the stored account's provider. */
const FASTMAIL = findEmailPreset(STORED_EMAIL_ACCOUNT.address)

/** Preset of a Gmail address. */
const GMAIL = findEmailPreset("ada@gmail.com")

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
  it("shows the saved account with the ports as text and the password field empty", () => {
    expect(SAVED_DRAFT).toEqual({
      address: "ada@fastmail.com",
      displayName: "Ada Fixture",
      userName: "ada@fastmail.com",
      password: "",
      imap: { host: "imap.fastmail.com", port: "993", security: "tls" },
      smtp: { host: "smtp.fastmail.com", port: "465", security: "tls" },
      serverKeepsSentCopy: true
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
})

describe("hasEmailPresetServers", () => {
  it("is true while both servers equal the preset's", () => {
    if (FASTMAIL === undefined) throw new Error("No Fastmail preset")

    expect(hasEmailPresetServers(SAVED_DRAFT, FASTMAIL)).toBe(true)
  })

  it.each([
    [
      "the IMAP host",
      { imap: { ...SAVED_DRAFT.imap, host: "mail.example.test" } }
    ],
    ["a port", { smtp: { ...SAVED_DRAFT.smtp, port: "587" } }],
    ["the security", { smtp: { ...SAVED_DRAFT.smtp, security: "starttls" } }]
  ] as const)("is false once %s differs", (_label, change) => {
    if (FASTMAIL === undefined) throw new Error("No Fastmail preset")

    expect(hasEmailPresetServers({ ...SAVED_DRAFT, ...change }, FASTMAIL)).toBe(
      false
    )
  })
})

describe("updateEmailAccountAddress", () => {
  it("fills empty server fields and the Sent copy from the address's preset", () => {
    expect(updateEmailAccountAddress(EMPTY_DRAFT, "ada@icloud.com")).toEqual({
      ...EMPTY_DRAFT,
      address: "ada@icloud.com",
      imap: { host: "imap.mail.me.com", port: "993", security: "tls" },
      smtp: { host: "smtp.mail.me.com", port: "587", security: "starttls" },
      serverKeepsSentCopy: false
    })
  })

  it("replaces the servers of the previous preset when the address moves to another provider", () => {
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
    const typed = {
      ...EMPTY_DRAFT,
      imap: { host: "mail.example.test", port: "993", security: "tls" }
    } as const

    expect(updateEmailAccountAddress(typed, "ada@gmail.com")).toEqual({
      ...typed,
      address: "ada@gmail.com"
    })
  })

  it("keeps the servers of a preset the person changed", () => {
    const gmail = updateEmailAccountAddress(EMPTY_DRAFT, "ada@gmail.com")
    const changed = { ...gmail, smtp: { ...gmail.smtp, port: "587" } }

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

  it("keeps the saved servers while the address is edited", () => {
    expect(updateEmailAccountAddress(SAVED_DRAFT, "ada@gmail.com")).toEqual({
      ...SAVED_DRAFT,
      address: "ada@gmail.com",
      imap: GMAIL === undefined ? undefined : { ...GMAIL.imap, port: "993" },
      smtp: GMAIL === undefined ? undefined : { ...GMAIL.smtp, port: "465" }
    })
  })

  it("keeps a typed address that has no preset yet while typing", () => {
    expect(updateEmailAccountAddress(EMPTY_DRAFT, "ada@gma")).toEqual({
      ...EMPTY_DRAFT,
      address: "ada@gma"
    })
  })
})

describe("parseEmailAccountDraft", () => {
  it("reads the saved account with an empty password field as unchanged", () => {
    expect(
      parseEmailAccountDraft(
        SAVED_DRAFT,
        STORED_EMAIL_ACCOUNT,
        STORED_EMAIL_PASSWORD
      )
    ).toEqual({ status: "unchanged" })
  })

  it("reads a typed account as changed, trimmed, with the ports as numbers", () => {
    const typed = {
      ...buildTypedGmailDraft(),
      address: " ada@gmail.com ",
      displayName: " Ada ",
      imap: { host: " imap.gmail.com ", port: " 993 ", security: "tls" }
    } as const

    expect(parseEmailAccountDraft(typed, null, null)).toEqual({
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
        STORED_EMAIL_ACCOUNT,
        STORED_EMAIL_PASSWORD
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
        STORED_EMAIL_ACCOUNT,
        STORED_EMAIL_PASSWORD
      )
    ).toEqual({
      status: "changed",
      account: { ...STORED_EMAIL_ACCOUNT, serverKeepsSentCopy: false },
      password: STORED_EMAIL_PASSWORD
    })
  })

  it.each<[string, Partial<EmailAccountDraft>, string, string]>([
    ["an address", { address: "ada" }, "address", "address"],
    [
      "a display name over the limit",
      { displayName: "a".repeat(201) },
      "displayName",
      "display name"
    ],
    ["an empty user name", { userName: "" }, "userName", "user name"],
    [
      "a host",
      { imap: { host: "mail server", port: "993", security: "tls" } },
      "imapHost",
      "host"
    ],
    [
      "a port that is not a whole number in range",
      { smtp: { host: "smtp.gmail.com", port: "70000", security: "tls" } },
      "smtpPort",
      "A port is a whole number from 1 to 65535."
    ],
    [
      "a port with letters",
      { smtp: { host: "smtp.gmail.com", port: "25a", security: "tls" } },
      "smtpPort",
      "A port is a whole number from 1 to 65535."
    ],
    [
      "a port of zero",
      { imap: { host: "imap.gmail.com", port: "0", security: "tls" } },
      "imapPort",
      "A port is a whole number from 1 to 65535."
    ],
    [
      "a password with a line break",
      { password: "app\npassword" },
      "password",
      "A password is 1 to 1024 characters, without line breaks or other control characters."
    ]
  ])("reports %s under its input", (_label, change, field, expectedProblem) => {
    const parse = parseEmailAccountDraft(
      { ...buildTypedGmailDraft(), ...change },
      null,
      null
    )

    expect(parse.status).toBe("invalid")
    if (parse.status !== "invalid") return
    expect(Object.keys(parse.problems)).toEqual([field])
    expect(parse.problems[field as keyof typeof parse.problems]).toContain(
      expectedProblem
    )
  })

  it("places a connection without TLS to another machine on that server's host", () => {
    const parse = parseEmailAccountDraft(
      {
        ...buildTypedGmailDraft(),
        smtp: { host: "smtp.gmail.com", port: "25", security: "plain" }
      },
      null,
      null
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
    const parse = parseEmailAccountDraft(
      {
        ...buildTypedGmailDraft(),
        imap: { host: "localhost", port: "143", security: "plain" }
      },
      null,
      null
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
        null,
        null
      )
    ).toEqual({
      status: "invalid",
      problems: { password: "Enter the password." }
    })
  })

  it("reports the first problem of every input, in the card's order", () => {
    const parse = parseEmailAccountDraft(
      { ...EMPTY_DRAFT, address: "ada", userName: "ada" },
      null,
      null
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
      null,
      null
    )

    expect(parse).toMatchObject({
      status: "changed",
      password: " app password "
    })
  })

  it("brands the password it returns", () => {
    const parse = parseEmailAccountDraft(buildTypedGmailDraft(), null, null)

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
        STORED_EMAIL_ACCOUNT,
        STORED_EMAIL_PASSWORD
      )
    ).toEqual({
      status: "changed",
      account: moved,
      password: STORED_EMAIL_PASSWORD
    })
  })
})
