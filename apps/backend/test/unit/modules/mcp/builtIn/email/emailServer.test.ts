import {
  emailAccountSchema,
  emailPasswordSchema,
  mcpServerSettingsSchema
} from "@lys/share"
import { readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"
import * as z from "zod"
import type { EmailAccountRead } from "../../../../../../src/infrastructure/settings/emailAccountFile"
import {
  buildEmailServerCommand,
  buildEmailServerSettings,
  createEmailMcpServer,
  EMAIL_ACCOUNT_VARIABLE_NAME,
  formatEmailAccountVariable
} from "../../../../../../src/modules/mcp/builtIn/email/emailServer"
import {
  buildEmailAccount,
  SYNTHETIC_EMAIL_PASSWORD
} from "../../../../support/emailTestServer"

/** Account the cases start the server with. */
const ACCOUNT = buildEmailAccount("accepted@example.com")

/** The installed server's command. */
const INSTALLED_COMMAND = buildEmailServerCommand(
  "/opt/lys/runtime/email/email"
)

/** The variable that holds the account and its password. */
const EXPECTED_VARIABLE = Object.freeze({
  name: EMAIL_ACCOUNT_VARIABLE_NAME,
  value: formatEmailAccountVariable(ACCOUNT, SYNTHETIC_EMAIL_PASSWORD)
})

/** Settings the installed server starts with for the account. */
const EXPECTED_SETTINGS = mcpServerSettingsSchema.parse({
  name: "email",
  transport: "stdio",
  command: "/opt/lys/runtime/email/email",
  arguments: [],
  environment: [EXPECTED_VARIABLE],
  enabled: true
})

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
 * Accounts with the value of `LYS_EMAIL_ACCOUNT` the backend writes for
 * each, which the email server's tests in `mcps/email/src/account.rs`
 * parse.
 */
const SHARED_ACCOUNT_VARIABLE_CASES = z
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

describe("buildEmailServerCommand", () => {
  it("runs the installed server without arguments", () => {
    expect(INSTALLED_COMMAND).toEqual({
      command: "/opt/lys/runtime/email/email",
      arguments: []
    })
    expect(Object.isFrozen(INSTALLED_COMMAND)).toBe(true)
  })
})

describe("formatEmailAccountVariable", () => {
  it.each(SHARED_ACCOUNT_VARIABLE_CASES)(
    "writes the shared variable of $case as one line of JSON",
    ({ account, password, variable }) => {
      const value = formatEmailAccountVariable(account, password)

      expect(value).not.toContain("\n")
      expect(JSON.parse(value)).toEqual(variable)
    }
  )
})

describe("buildEmailServerSettings", () => {
  it("builds switched-on stdio settings named email whose only variable holds the account and the password", () => {
    const settings = buildEmailServerSettings(
      INSTALLED_COMMAND,
      ACCOUNT,
      SYNTHETIC_EMAIL_PASSWORD
    )

    expect(settings).toEqual(EXPECTED_SETTINGS)
    expect(Object.isFrozen(settings)).toBe(true)
  })

  it("keeps the arguments of a command that runs the server through another program", () => {
    const settings = buildEmailServerSettings(
      { command: "/usr/bin/env", arguments: ["email-server"] },
      ACCOUNT,
      SYNTHETIC_EMAIL_PASSWORD
    )

    expect(settings.transport === "stdio" && settings.arguments).toEqual([
      "email-server"
    ])
  })
})

describe("createEmailMcpServer", () => {
  it("is the stdio server named email, which reads nothing until asked", () => {
    const readAccount = vi.fn<() => Promise<EmailAccountRead>>()

    const server = createEmailMcpServer(INSTALLED_COMMAND, readAccount)

    expect(server.name).toBe("email")
    expect(server.transport).toBe("stdio")
    expect(readAccount).not.toHaveBeenCalled()
  })

  it("reads the saved account again on each read, and builds the settings that start the server with it", async () => {
    const readAccount = vi.fn<() => Promise<EmailAccountRead>>(() =>
      Promise.resolve({
        status: "read",
        account: ACCOUNT,
        password: SYNTHETIC_EMAIL_PASSWORD
      })
    )
    const server = createEmailMcpServer(INSTALLED_COMMAND, readAccount)

    const first = await server.readServer()
    const second = await server.readServer()

    expect(first).toEqual({ status: "read", settings: EXPECTED_SETTINGS })
    expect(second).toEqual(first)
    expect(Object.isFrozen(first)).toBe(true)
    expect(readAccount).toHaveBeenCalledTimes(2)
  })

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
    "reads %s as a server that cannot start",
    async (_label, read, status) => {
      const server = createEmailMcpServer(INSTALLED_COMMAND, () =>
        Promise.resolve(read)
      )

      expect(await server.readServer()).toEqual({ status })
    }
  )
})
