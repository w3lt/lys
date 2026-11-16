import { MAXIMUM_SETTINGS_FILE_BYTES } from "@lys/share"
import { readFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import * as z from "zod"
import {
  readEmailAccounts,
  type EmailAccountRead
} from "../../../../src/infrastructure/settings/emailAccountFile"
import {
  createSettingsFilePath,
  writeSettingsFile
} from "../../support/settingsFile"

/** Synthetic password standing in for a secret; not a real credential. */
const SYNTHETIC_PASSWORD = "synthetic-password-7f3a"

/** Synthetic password of Lys's account; not a real credential. */
const SYNTHETIC_LYS_PASSWORD = "synthetic-lys-password-9c1e"

/** An account as the desktop writes it. */
const ACCOUNT = Object.freeze({
  address: "person@example.com",
  displayName: "A Person",
  userName: "person@example.com",
  imap: { host: "imap.example.com", port: 993, security: "tls" },
  smtp: { host: "smtp.example.com", port: 587, security: "starttls" },
  serverKeepsSentCopy: true
})

/** Lys's own account as the desktop writes it. */
const LYS_ACCOUNT = Object.freeze({
  address: "lys@example.net",
  displayName: "Lys",
  userName: "lys@example.net",
  imap: { host: "imap.example.net", port: 993, security: "tls" },
  smtp: { host: "smtp.example.net", port: 465, security: "tls" },
  serverKeepsSentCopy: false
})

/** Read of both accounts when the file holds no settings document. */
const UNREADABLE_ACCOUNTS = Object.freeze({
  person: { status: "unreadable" },
  lys: { status: "unreadable" }
})

/** Read of both accounts when the `email` group breaks its rules. */
const INVALID_ACCOUNTS = Object.freeze({
  person: { status: "invalid" },
  lys: { status: "invalid" }
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
 * the `email` group as given and {@link SYNTHETIC_LYS_PASSWORD} as Lys's
 * password.
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
    secrets: {
      tavilyApiKey: null,
      emailPassword,
      lysEmailPassword: SYNTHETIC_LYS_PASSWORD
    },
    mcp: { servers: [], builtIn: { email: { enabled: true } } },
    email,
    futureGroup: { anything: [1, 2, 3] }
  })
}

/**
 * Reads the person's account from a settings file.
 *
 * @param path - Absolute path of the settings file.
 * @returns What the file holds for the person's account.
 */
async function readPersonAccount(path: string): Promise<EmailAccountRead> {
  return (await readEmailAccounts(path)).person
}

describe("readEmailAccounts", () => {
  it("reads a saved account and its password, and no account of Lys's, ignoring every other group and field", async () => {
    const path = await writeSettingsFile(
      buildSettingsText(ACCOUNT, SYNTHETIC_PASSWORD)
    )

    const read = await readEmailAccounts(path)

    expect(read).toEqual({
      person: {
        status: "read",
        account: ACCOUNT,
        password: SYNTHETIC_PASSWORD
      },
      lys: { status: "missing" }
    })
    expect(Object.isFrozen(read)).toBe(true)
    expect(Object.isFrozen(read.person)).toBe(true)
    expect(
      read.person.status === "read" && Object.isFrozen(read.person.account)
    ).toBe(true)
  })

  it("reads Lys's account with her own password beside the person's account with theirs", async () => {
    const path = await writeSettingsFile(
      buildSettingsTextOfGroup(
        { account: ACCOUNT, lysAccount: LYS_ACCOUNT },
        SYNTHETIC_PASSWORD
      )
    )

    const read = await readEmailAccounts(path)

    expect(read).toEqual({
      person: {
        status: "read",
        account: ACCOUNT,
        password: SYNTHETIC_PASSWORD
      },
      lys: {
        status: "read",
        account: LYS_ACCOUNT,
        password: SYNTHETIC_LYS_PASSWORD
      }
    })
    expect(Object.isFrozen(read.lys)).toBe(true)
  })

  it.each([
    {
      label: "Lys's",
      secrets: { emailPassword: SYNTHETIC_PASSWORD },
      expected: { person: "read", lys: "invalid" }
    },
    {
      label: "the person's",
      secrets: { lysEmailPassword: SYNTHETIC_LYS_PASSWORD },
      expected: { person: "invalid", lys: "read" }
    }
  ])(
    "reports an account saved without $label password as invalid, and still reads the other",
    async ({ secrets, expected }) => {
      const path = await writeSettingsFile(
        JSON.stringify({
          email: { account: ACCOUNT, lysAccount: LYS_ACCOUNT },
          secrets
        })
      )

      const read = await readEmailAccounts(path)

      expect(read.person.status).toBe(expected.person)
      expect(read.lys.status).toBe(expected.lys)
    }
  )

  it.each(["993.0", "9.93e2"])(
    "reads an IMAP port written as %s as the port 993, as the desktop host does",
    async (writtenPort) => {
      const text = buildSettingsText(ACCOUNT, SYNTHETIC_PASSWORD).replace(
        '"port":993,',
        `"port":${writtenPort},`
      )
      expect(text).toContain(`"port":${writtenPort},`)
      const path = await writeSettingsFile(text)

      expect(await readPersonAccount(path)).toEqual({
        status: "read",
        account: ACCOUNT,
        password: SYNTHETIC_PASSWORD
      })
    }
  )

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

    expect(await readPersonAccount(path)).toEqual({ status: "missing" })
  })

  it("reads a missing settings file as no account for either", async () => {
    const path = await createSettingsFilePath()

    expect(await readEmailAccounts(path)).toEqual({
      person: { status: "missing" },
      lys: { status: "missing" }
    })
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

    expect(await readPersonAccount(path)).toEqual({ status: "invalid" })
  })

  it.each([
    ["a null email group", '{ "email": null }'],
    ["an email group that is text", '{ "email": "person@example.com" }'],
    ["an email group that is an array", '{ "email": [] }'],
    [
      "an email group with an unknown field",
      '{ "email": { "account": null, "signature": "Regards" } }'
    ]
  ])(
    "reports %s as invalid for both accounts, never as no account, with nothing from the file",
    async (_label, text) => {
      const path = await writeSettingsFile(text)

      const read = await readEmailAccounts(path)

      expect(read).toEqual(INVALID_ACCOUNTS)
      expect(JSON.stringify(read)).not.toContain("example.com")
    }
  )

  it("reports an account saved beside a secrets group that is text as invalid, with nothing from the file", async () => {
    const path = await writeSettingsFile(
      JSON.stringify({ email: { account: ACCOUNT }, secrets: "text" })
    )

    const read = await readPersonAccount(path)

    expect(read).toEqual({ status: "invalid" })
    expect(JSON.stringify(read)).not.toContain("person")
  })

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

      expect(await readPersonAccount(path)).toEqual({ status: "invalid" })
    }
  )

  it("accepts a password of exactly 1024 characters with spaces inside", async () => {
    const password = `${"p".repeat(512)} ${"q".repeat(511)}`
    const path = await writeSettingsFile(buildSettingsText(ACCOUNT, password))

    expect(await readPersonAccount(path)).toEqual({
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

      const read = await readEmailAccounts(path)

      expect(read).toEqual(UNREADABLE_ACCOUNTS)
      expect(JSON.stringify(read)).not.toContain("7f3a")
    }
  )

  it("reports bytes that are not UTF-8 as unreadable", async () => {
    const path = await writeSettingsFile(
      Uint8Array.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d])
    )

    expect(await readEmailAccounts(path)).toEqual(UNREADABLE_ACCOUNTS)
  })

  it("reads a file of exactly the size limit", async () => {
    const text = buildSettingsText(ACCOUNT, SYNTHETIC_PASSWORD)
    const path = await writeSettingsFile(
      text.padEnd(MAXIMUM_SETTINGS_FILE_BYTES, " ")
    )

    expect(await readPersonAccount(path)).toEqual({
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

    expect(await readEmailAccounts(path)).toEqual(UNREADABLE_ACCOUNTS)
  })

  it("reports a directory at the settings path as unreadable", async () => {
    const path = await createSettingsFilePath()
    await mkdir(path)

    expect(await readEmailAccounts(path)).toEqual(UNREADABLE_ACCOUNTS)
  })
})

describe("readEmailAccounts on the groups shared with the desktop host", () => {
  /** Validates the group the desktop host writes back for an accepted one. */
  const writtenEmailGroupSchema = z.strictObject({
    account: z.unknown(),
    lysAccount: z.unknown()
  })

  /**
   * Validates one case of the groups shared with the desktop host: an
   * accepted group comes with what the host writes back for it.
   */
  const sharedEmailGroupCaseSchema = z.discriminatedUnion("accepted", [
    z.strictObject({
      case: z.string(),
      group: z.unknown(),
      accepted: z.literal(true),
      written: writtenEmailGroupSchema
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
  const sharedEmailGroupCases = z
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

  /**
   * Builds the read expected of one account the host writes back.
   *
   * @param account - The written account, or `null` for none.
   * @param password - The password saved with it.
   * @returns `missing` for no account, otherwise `read` with the password.
   */
  function buildExpectedRead(
    account: unknown,
    password: string
  ): Readonly<Record<string, unknown>> {
    return account === null
      ? { status: "missing" }
      : { status: "read", account, password }
  }

  it.each(sharedEmailGroupCases.filter((sharedCase) => sharedCase.accepted))(
    "reads $case, and reads what the host writes back as the same accounts",
    async ({ group, written }) => {
      const read = await readEmailAccounts(
        await writeSettingsFile(
          buildSettingsTextOfGroup(group, SYNTHETIC_PASSWORD)
        )
      )
      const readWritten = await readEmailAccounts(
        await writeSettingsFile(
          buildSettingsTextOfGroup(written, SYNTHETIC_PASSWORD)
        )
      )

      expect(read).toEqual({
        person: buildExpectedRead(written.account, SYNTHETIC_PASSWORD),
        lys: buildExpectedRead(written.lysAccount, SYNTHETIC_LYS_PASSWORD)
      })
      expect(readWritten).toEqual(read)
    }
  )

  it.each(sharedEmailGroupCases.filter((sharedCase) => !sharedCase.accepted))(
    "reports $case as invalid for both accounts",
    async ({ group }) => {
      const read = await readEmailAccounts(
        await writeSettingsFile(
          buildSettingsTextOfGroup(group, SYNTHETIC_PASSWORD)
        )
      )

      expect(read).toEqual(INVALID_ACCOUNTS)
    }
  )
})
