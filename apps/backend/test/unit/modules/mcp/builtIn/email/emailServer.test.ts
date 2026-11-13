import type { McpServerList, McpServerState } from "@lys/protocol"
import {
  emailAccountSchema,
  emailPasswordSchema,
  mcpServerSettingsSchema,
  mcpSettingsSchema,
  type McpSettings
} from "@lys/share"
import { readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"
import * as z from "zod"
import type {
  EmailAccountRead,
  EmailAccountsRead
} from "../../../../../../src/infrastructure/settings/emailAccountFile"
import {
  buildEmailAccountVariable,
  buildEmailServerCommand,
  buildEmailServerSettings,
  EMAIL_ACCOUNT_VARIABLE_NAME,
  EmailMcpServer,
  LYS_EMAIL_ACCOUNT_VARIABLE_NAME
} from "../../../../../../src/modules/mcp/builtIn/email/emailServer"
import {
  buildEmailAccount,
  SYNTHETIC_EMAIL_PASSWORD
} from "../../../../support/emailTestServer"

/** The person's account. */
const ACCOUNT = buildEmailAccount("accepted@example.com")

/** Lys's own account. */
const LYS_ACCOUNT = buildEmailAccount("lys@example.net")

/** The installed server's command. */
const INSTALLED_COMMAND = buildEmailServerCommand(
  "/opt/lys/runtime/email/email"
)

/** The person's mailbox, served. */
const PERSON_MAILBOX = Object.freeze({
  variableName: EMAIL_ACCOUNT_VARIABLE_NAME,
  account: ACCOUNT,
  password: SYNTHETIC_EMAIL_PASSWORD
})

/** Lys's own mailbox, served. */
const LYS_MAILBOX = Object.freeze({
  variableName: LYS_EMAIL_ACCOUNT_VARIABLE_NAME,
  account: LYS_ACCOUNT,
  password: SYNTHETIC_EMAIL_PASSWORD
})

/** The variable that holds the person's account and its password. */
const PERSON_VARIABLE = Object.freeze({
  name: EMAIL_ACCOUNT_VARIABLE_NAME,
  value: buildEmailAccountVariable(ACCOUNT, SYNTHETIC_EMAIL_PASSWORD)
})

/** The variable that holds Lys's account and its password. */
const LYS_VARIABLE = Object.freeze({
  name: LYS_EMAIL_ACCOUNT_VARIABLE_NAME,
  value: buildEmailAccountVariable(LYS_ACCOUNT, SYNTHETIC_EMAIL_PASSWORD)
})

/** Read of both accounts, saved and usable. */
const BOTH_READ: EmailAccountsRead = Object.freeze({
  person: Object.freeze({
    status: "read",
    account: ACCOUNT,
    password: SYNTHETIC_EMAIL_PASSWORD
  }),
  lys: Object.freeze({
    status: "read",
    account: LYS_ACCOUNT,
    password: SYNTHETIC_EMAIL_PASSWORD
  })
})

/**
 * Builds settings the installed server starts with.
 *
 * @param environment - Its variables, in order.
 * @returns The validated settings.
 */
function buildExpectedSettings(
  environment: readonly Readonly<{ name: string; value: string }>[]
) {
  return mcpServerSettingsSchema.parse({
    name: "email",
    transport: "stdio",
    command: "/opt/lys/runtime/email/email",
    arguments: [],
    environment,
    enabled: true
  })
}

/**
 * Builds the applied `mcp` group with the email server's mailbox switches.
 *
 * @param enabled - Whether the person's mailbox is on.
 * @param lysEnabled - Whether Lys's own mailbox is on.
 * @returns The validated group, with no added server.
 */
function buildMcpSettings(enabled: boolean, lysEnabled: boolean): McpSettings {
  return mcpSettingsSchema.parse({
    builtIn: { email: { enabled, lysEnabled } }
  })
}

/**
 * Builds the registry's list of applied servers with one server named
 * `email`.
 *
 * @param isBuiltIn - Whether it is the built-in server.
 * @param state - Its state.
 * @returns The list.
 */
function buildServerList(
  isBuiltIn: boolean,
  state: McpServerState
): McpServerList {
  return {
    settings: "applied",
    servers: [{ name: "email", transport: "stdio", isBuiltIn, state }]
  }
}

/** The registry's list while the built-in email server connects. */
const CONNECTING_LIST = buildServerList(true, { status: "connecting" })

describe("buildEmailServerCommand", () => {
  it("runs the installed server without arguments", () => {
    expect(INSTALLED_COMMAND).toEqual({
      command: "/opt/lys/runtime/email/email",
      arguments: []
    })
    expect(Object.isFrozen(INSTALLED_COMMAND)).toBe(true)
  })
})

describe("buildEmailAccountVariable", () => {
  /**
   * Validates one case of the account variables shared with the email
   * server's tests: an account, its password, and the JSON the variable
   * holds for them.
   */
  const sharedAccountVariableCaseSchema = z.strictObject({
    case: z.string(),
    account: emailAccountSchema,
    password: emailPasswordSchema,
    variable: z.record(z.string(), z.unknown())
  })

  /**
   * Accounts with the value of an account variable the backend writes for
   * each, which the email server's tests in `mcps/email/src/account.rs`
   * parse.
   */
  const sharedAccountVariableCases = z
    .array(sharedAccountVariableCaseSchema)
    .parse(
      JSON.parse(
        readFileSync(
          new URL(
            "../../../../../../../../packages/share/test/fixtures/email-account-variables.json",
            import.meta.url
          ),
          "utf8"
        )
      )
    )

  it.each(sharedAccountVariableCases)(
    "writes the shared variable of $case as one line of JSON",
    ({ account, password, variable }) => {
      const value = buildEmailAccountVariable(account, password)

      expect(value).not.toContain("\n")
      expect(JSON.parse(value)).toEqual(variable)
    }
  )
})

describe("buildEmailServerSettings", () => {
  it.each([
    ["the person's", [PERSON_MAILBOX], [PERSON_VARIABLE]],
    ["Lys's", [LYS_MAILBOX], [LYS_VARIABLE]],
    ["both", [PERSON_MAILBOX, LYS_MAILBOX], [PERSON_VARIABLE, LYS_VARIABLE]]
  ])(
    "builds switched-on stdio settings named email with a variable for each of %s mailboxes",
    (_label, mailboxes, environment) => {
      const settings = buildEmailServerSettings(INSTALLED_COMMAND, mailboxes)

      expect(settings).toEqual(buildExpectedSettings(environment))
      expect(Object.isFrozen(settings)).toBe(true)
    }
  )

  it("keeps the arguments of a command that runs the server through another program", () => {
    const settings = buildEmailServerSettings(
      { command: "/usr/bin/env", arguments: ["email-server"] },
      [PERSON_MAILBOX]
    )

    expect(settings.transport === "stdio" && settings.arguments).toEqual([
      "email-server"
    ])
  })
})

describe("EmailMcpServer", () => {
  it("is the stdio server named email, which reads nothing until asked", () => {
    const readAccounts = vi.fn<() => Promise<EmailAccountsRead>>()

    const server = new EmailMcpServer(INSTALLED_COMMAND, readAccounts)

    expect(server.name).toBe("email")
    expect(server.transport).toBe("stdio")
    expect(readAccounts).not.toHaveBeenCalled()
    expect(server.readLysEmailAddress(CONNECTING_LIST)).toBeNull()
  })

  it.each([
    ["the person's", buildMcpSettings(true, false), [PERSON_VARIABLE]],
    ["Lys's", buildMcpSettings(false, true), [LYS_VARIABLE]],
    ["both", buildMcpSettings(true, true), [PERSON_VARIABLE, LYS_VARIABLE]]
  ])(
    "reads the saved accounts again on each read, and starts the server with only %s mailboxes, those switched on",
    async (_label, settings, environment) => {
      const readAccounts = vi.fn(() => Promise.resolve(BOTH_READ))
      const server = new EmailMcpServer(INSTALLED_COMMAND, readAccounts)

      const first = await server.readServer(settings)
      const second = await server.readServer(settings)

      expect(first).toEqual({
        status: "read",
        settings: buildExpectedSettings(environment)
      })
      expect(second).toEqual(first)
      expect(Object.isFrozen(first)).toBe(true)
      expect(readAccounts).toHaveBeenCalledTimes(2)
    }
  )

  it.each([
    ["no account", { status: "missing" }, "account-missing"],
    [
      "an account that fails its rules",
      { status: "invalid" },
      "account-invalid"
    ],
    [
      "a settings file that cannot be read",
      { status: "unreadable" },
      "account-invalid"
    ]
  ] as const)(
    "reads %s for a mailbox that is on as a server that cannot start, and ignores it for a mailbox that is off",
    async (_label, read: EmailAccountRead, status) => {
      const server = new EmailMcpServer(INSTALLED_COMMAND, () =>
        Promise.resolve({ person: BOTH_READ.person, lys: read })
      )

      expect(await server.readServer(buildMcpSettings(true, true))).toEqual({
        status
      })
      expect(await server.readServer(buildMcpSettings(true, false))).toEqual({
        status: "read",
        settings: buildExpectedSettings([PERSON_VARIABLE])
      })
    }
  )

  it("reports an unusable account before a missing one", async () => {
    const server = new EmailMcpServer(INSTALLED_COMMAND, () =>
      Promise.resolve({
        person: { status: "missing" },
        lys: { status: "invalid" }
      })
    )

    expect(await server.readServer(buildMcpSettings(true, true))).toEqual({
      status: "account-invalid"
    })
  })

  it("refuses a read with both mailboxes off without reading anything", async () => {
    const readAccounts = vi.fn(() => Promise.resolve(BOTH_READ))
    const server = new EmailMcpServer(INSTALLED_COMMAND, readAccounts)

    await expect(
      server.readServer(buildMcpSettings(false, false))
    ).rejects.toThrow(TypeError)
    expect(readAccounts).not.toHaveBeenCalled()
  })

  describe("readLysEmailAddress", () => {
    /** Address of Lys's account; personal data in production. */
    const LYS_ADDRESS = LYS_ACCOUNT.address

    it.each([
      ["connecting", CONNECTING_LIST, LYS_ADDRESS],
      [
        "failed",
        buildServerList(true, { status: "failed", reason: "start-failed" }),
        LYS_ADDRESS
      ],
      ["off", buildServerList(true, { status: "off" }), null],
      [
        "an added server's",
        buildServerList(false, { status: "connecting" }),
        null
      ],
      ["missing", { settings: "applied", servers: [] }, null]
    ] as const)(
      "gives Lys's address after a read that served her mailbox only while the email server is %s as the registry lists it",
      async (_label, servers: McpServerList, address) => {
        const server = new EmailMcpServer(INSTALLED_COMMAND, () =>
          Promise.resolve(BOTH_READ)
        )

        await server.readServer(buildMcpSettings(true, true))

        expect(server.readLysEmailAddress(servers)).toBe(address)
      }
    )

    it("forgets Lys's address after a read that does not serve her mailbox", async () => {
      const readAccounts = vi.fn<() => Promise<EmailAccountsRead>>(() =>
        Promise.resolve(BOTH_READ)
      )
      const server = new EmailMcpServer(INSTALLED_COMMAND, readAccounts)
      await server.readServer(buildMcpSettings(false, true))
      const served = server.readLysEmailAddress(CONNECTING_LIST)
      await server.readServer(buildMcpSettings(true, false))
      const switchedOff = server.readLysEmailAddress(CONNECTING_LIST)
      await server.readServer(buildMcpSettings(false, true))
      readAccounts.mockResolvedValueOnce({
        person: BOTH_READ.person,
        lys: { status: "invalid" }
      })
      await server.readServer(buildMcpSettings(false, true))

      expect([served, switchedOff]).toEqual([LYS_ADDRESS, null])
      expect(server.readLysEmailAddress(CONNECTING_LIST)).toBeNull()
    })
  })
})
