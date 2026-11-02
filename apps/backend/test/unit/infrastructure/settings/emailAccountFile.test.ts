import { MAXIMUM_SETTINGS_FILE_BYTES } from "@lys/share"
import { readFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import * as z from "zod"
import { readEmailAccount } from "../../../../src/infrastructure/settings/emailAccountFile"
import {
  createSettingsFilePath,
  writeSettingsFile
} from "../../support/settingsFile"

/** Synthetic password standing in for a secret; not a real credential. */
const SYNTHETIC_PASSWORD = "synthetic-password-7f3a"

/** An account as the desktop writes it. */
const ACCOUNT = Object.freeze({
  address: "person@example.com",
  displayName: "A Person",
  userName: "person@example.com",
  imap: { host: "imap.example.com", port: 993, security: "tls" },
  smtp: { host: "smtp.example.com", port: 587, security: "starttls" },
  serverKeepsSentCopy: true
})

/**
 * Builds settings file text holding every group the desktop writes.
 *
 * @param account - Value of `email.account`.
 * @param emailPassword - Value of `secrets.emailPassword`.
 * @returns The JSON text.
 */
function buildSettingsText(account: unknown, emailPassword: unknown): string {
  return buildSettingsTextOfGroup({ account }, emailPassword)
}

/**
 * Builds settings file text holding every group the desktop writes, with
 * the `email` group as given.
 *
 * @param email - Value of the `email` group.
 * @param emailPassword - Value of `secrets.emailPassword`.
 * @returns The JSON text.
 */
function buildSettingsTextOfGroup(
  email: unknown,
  emailPassword: unknown
): string {
  return JSON.stringify({
    runtime: { autoStartBackend: true, defaultModel: null },
    secrets: { tavilyApiKey: null, emailPassword },
    mcp: { servers: [], builtIn: { email: { enabled: true } } },
    email,
    futureGroup: { anything: [1, 2, 3] }
  })
}

/**
 * Validates one case of the groups shared with the desktop host: an
 * accepted group comes with what the host writes back for it.
 */
const sharedEmailGroupCaseSchema = z.discriminatedUnion("accepted", [
  z.strictObject({
    case: z.string(),
    group: z.unknown(),
    accepted: z.literal(true),
    written: z.strictObject({ account: z.unknown() })
  }),
  z.strictObject({
    case: z.string(),
    group: z.unknown(),
    accepted: z.literal(false)
  })
])

/**
 * Groups that this reader and the desktop host must judge alike; the host's
 * tests in `src-tauri/src/settings/email.rs` read the same file.
 */
const SHARED_EMAIL_GROUP_CASES = z
  .array(sharedEmailGroupCaseSchema)
  .parse(
    JSON.parse(
      readFileSync(
        new URL(
          "../../../../../../packages/share/test/fixtures/email-settings-groups.json",
          import.meta.url
        ),
        "utf8"
      )
    )
  )

describe("readEmailAccount", () => {
  it("reads a saved account and its password, ignoring every other group and field", async () => {
    const path = await writeSettingsFile(
      buildSettingsText(ACCOUNT, SYNTHETIC_PASSWORD)
    )

    const read = await readEmailAccount(path)

    expect(read).toEqual({
      status: "read",
      account: ACCOUNT,
      password: SYNTHETIC_PASSWORD
    })
    expect(Object.isFrozen(read)).toBe(true)
    expect(read.status === "read" && Object.isFrozen(read.account)).toBe(true)
  })

  it.each([
    ["no email group", "{}"],
    ["an empty email group", '{ "email": {} }'],
    ["a null account", '{ "email": { "account": null } }'],
    [
      "a null account beside a saved password",
      `{ "email": { "account": null }, "secrets": { "emailPassword": "${SYNTHETIC_PASSWORD}" } }`
    ],
    [
      "a null account beside a secrets group that is text",
      '{ "email": { "account": null }, "secrets": "text" }'
    ]
  ])("reads %s as no account", async (_label, text) => {
    const path = await writeSettingsFile(text)

    expect(await readEmailAccount(path)).toEqual({ status: "missing" })
  })

  it("reads a missing settings file as no account", async () => {
    const path = await createSettingsFilePath()

    expect(await readEmailAccount(path)).toEqual({ status: "missing" })
  })

  it.each([
    ["an account without an address", { ...ACCOUNT, address: undefined }],
    ["an account with an address without @", { ...ACCOUNT, address: "person" }],
    ["an account with an unknown field", { ...ACCOUNT, signature: "Regards" }],
    [
      "an account with a plain connection to a remote host",
      { ...ACCOUNT, imap: { ...ACCOUNT.imap, security: "plain" } }
    ],
    ["an account that is text", "person@example.com"]
  ])("reports %s as invalid, never as no account", async (_label, account) => {
    const path = await writeSettingsFile(
      buildSettingsText(account, SYNTHETIC_PASSWORD)
    )

    expect(await readEmailAccount(path)).toEqual({ status: "invalid" })
  })

  it.each([
    ["a null email group", '{ "email": null }'],
    ["an email group that is text", '{ "email": "person@example.com" }'],
    ["an email group that is an array", '{ "email": [] }'],
    [
      "an email group with an unknown field",
      '{ "email": { "account": null, "signature": "Regards" } }'
    ],
    [
      "a secrets group that is text beside a saved account",
      JSON.stringify({ email: { account: ACCOUNT }, secrets: "text" })
    ]
  ])(
    "reports %s as invalid, never as no account, with nothing from the file",
    async (_label, text) => {
      const path = await writeSettingsFile(text)

      const read = await readEmailAccount(path)

      expect(read).toEqual({ status: "invalid" })
      expect(JSON.stringify(read)).not.toContain("person")
    }
  )

  it.each([
    ["no secrets group", undefined],
    ["a null password", null],
    ["an empty password", ""],
    ["a password with a line break", `${SYNTHETIC_PASSWORD}\n`],
    ["a password longer than 1024 characters", "p".repeat(1025)],
    ["a password that is a number", 42]
  ])(
    "reports an account saved with %s as invalid, never as no account",
    async (_label, emailPassword) => {
      const text =
        emailPassword === undefined
          ? JSON.stringify({ email: { account: ACCOUNT } })
          : buildSettingsText(ACCOUNT, emailPassword)
      const path = await writeSettingsFile(text)

      expect(await readEmailAccount(path)).toEqual({ status: "invalid" })
    }
  )

  it("accepts a password of exactly 1024 characters with spaces inside", async () => {
    const password = `${"p".repeat(512)} ${"q".repeat(511)}`
    const path = await writeSettingsFile(buildSettingsText(ACCOUNT, password))

    expect(await readEmailAccount(path)).toEqual({
      status: "read",
      account: ACCOUNT,
      password
    })
  })

  it.each([
    [
      "text that is not JSON",
      `{ "email": { "account": {} }, "secrets": { "emailPassword": "${SYNTHETIC_PASSWORD}" `
    ],
    ["a JSON array", "[]"],
    ["a JSON string", '"settings"'],
    ["a JSON null", "null"]
  ])(
    "reports %s as unreadable, with nothing from the file",
    async (_label, text) => {
      const path = await writeSettingsFile(text)

      const read = await readEmailAccount(path)

      expect(read).toEqual({ status: "unreadable" })
      expect(JSON.stringify(read)).not.toContain("7f3a")
    }
  )

  it("reports bytes that are not UTF-8 as unreadable", async () => {
    const path = await writeSettingsFile(
      Uint8Array.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d])
    )

    expect(await readEmailAccount(path)).toEqual({ status: "unreadable" })
  })

  it("reads a file of exactly the size limit", async () => {
    const text = buildSettingsText(ACCOUNT, SYNTHETIC_PASSWORD)
    const path = await writeSettingsFile(
      text.padEnd(MAXIMUM_SETTINGS_FILE_BYTES, " ")
    )

    expect(await readEmailAccount(path)).toEqual({
      status: "read",
      account: ACCOUNT,
      password: SYNTHETIC_PASSWORD
    })
  })

  it("reports a file one byte over the size limit as unreadable", async () => {
    const text = buildSettingsText(ACCOUNT, SYNTHETIC_PASSWORD)
    const path = await writeSettingsFile(
      text.padEnd(MAXIMUM_SETTINGS_FILE_BYTES + 1, " ")
    )

    expect(await readEmailAccount(path)).toEqual({ status: "unreadable" })
  })

  it("reports a directory at the settings path as unreadable", async () => {
    const path = await createSettingsFilePath()
    await mkdir(path)

    expect(await readEmailAccount(path)).toEqual({ status: "unreadable" })
  })
})

describe("readEmailAccount on the groups shared with the desktop host", () => {
  it.each(SHARED_EMAIL_GROUP_CASES.filter((sharedCase) => sharedCase.accepted))(
    "reads $case, and reads what the host writes back as the same account",
    async ({ group, written }) => {
      const read = await readEmailAccount(
        await writeSettingsFile(
          buildSettingsTextOfGroup(group, SYNTHETIC_PASSWORD)
        )
      )
      const readWritten = await readEmailAccount(
        await writeSettingsFile(
          buildSettingsTextOfGroup(written, SYNTHETIC_PASSWORD)
        )
      )

      expect(read).toEqual(
        written.account === null
          ? { status: "missing" }
          : {
              status: "read",
              account: written.account,
              password: SYNTHETIC_PASSWORD
            }
      )
      expect(readWritten).toEqual(read)
    }
  )

  it.each(
    SHARED_EMAIL_GROUP_CASES.filter((sharedCase) => !sharedCase.accepted)
  )("reports $case as invalid", async ({ group }) => {
    const read = await readEmailAccount(
      await writeSettingsFile(
        buildSettingsTextOfGroup(group, SYNTHETIC_PASSWORD)
      )
    )

    expect(read).toEqual({ status: "invalid" })
  })
})
