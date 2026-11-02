import { mcpServerSettingsSchema } from "@lys/share"
import { describe, expect, it, vi } from "vitest"
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

/** Settings the installed server starts with for the account. */
const EXPECTED_SETTINGS = mcpServerSettingsSchema.parse({
  name: "email",
  transport: "stdio",
  command: "/opt/lys/runtime/email/email",
  arguments: [],
  environment: [
    {
      name: EMAIL_ACCOUNT_VARIABLE_NAME,
      value: JSON.stringify({
        address: "accepted@example.com",
        displayName: "Test Person",
        userName: "accepted@example.com",
        password: SYNTHETIC_EMAIL_PASSWORD,
        imap: { host: "imap.example.com", port: 993, security: "tls" },
        smtp: { host: "smtp.example.com", port: 465, security: "tls" },
        serverKeepsSentCopy: false
      })
    }
  ],
  enabled: true
})

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
  it("writes the account's fields and the password as one line of JSON", () => {
    const value = formatEmailAccountVariable(ACCOUNT, SYNTHETIC_EMAIL_PASSWORD)

    expect(value).not.toContain("\n")
    expect(JSON.parse(value)).toEqual({
      address: "accepted@example.com",
      displayName: "Test Person",
      userName: "accepted@example.com",
      password: SYNTHETIC_EMAIL_PASSWORD,
      imap: { host: "imap.example.com", port: 993, security: "tls" },
      smtp: { host: "smtp.example.com", port: 465, security: "tls" },
      serverKeepsSentCopy: false
    })
  })
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
