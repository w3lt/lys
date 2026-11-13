import {
  mcpServerSettingsSchema,
  type BuiltInMcpServerName,
  type EmailAccount,
  type EmailPassword,
  type McpEnvironmentVariable,
  type McpServerSettings
} from "@lys/share"
import type { EmailAccountsRead } from "../../../../infrastructure/settings/emailAccountFile"
import type {
  BuiltInMcpServer,
  BuiltInMcpServerRead
} from "../../mcpServerRegistry"

/** Name the email server is listed under, and its tools are prefixed with. */
export const EMAIL_SERVER_NAME = "email" satisfies BuiltInMcpServerName

/**
 * Environment variable the email server reads its account and password
 * from, as the JSON text {@link buildEmailAccountVariable} writes.
 */
export const EMAIL_ACCOUNT_VARIABLE_NAME = "LYS_EMAIL_ACCOUNT"

/** How the email server Lys ships is run, before any subcommand. */
export type EmailServerCommand = Readonly<{
  /**
   * Program to run: the installed server, or the interpreter that runs a
   * fake one in tests.
   */
  command: string
  /** Arguments before the subcommand; none for the installed server. */
  arguments: readonly string[]
}>

/**
 * Builds the command that runs the installed email server.
 *
 * @param emailServerPath - Absolute path of the server's executable, which
 * need not exist: a missing file fails the server's start and the account
 * check, which Settings reports.
 * @returns A frozen command without arguments.
 */
export function buildEmailServerCommand(
  emailServerPath: string
): EmailServerCommand {
  return Object.freeze({
    command: emailServerPath,
    arguments: Object.freeze([])
  })
}

/**
 * Creates the built-in email server the MCP server registry applies.
 *
 * @param serverCommand - How the email server is run; borrowed for the
 * server's lifetime.
 * @param readAccounts - Reads the saved email accounts and their passwords
 * again; borrowed for the server's lifetime.
 * @returns A frozen server named `email` over stdio, whose read builds the
 * settings that start the server with the person's saved account and
 * password in the {@link EMAIL_ACCOUNT_VARIABLE_NAME} variable; a missing
 * account reads as `account-missing`, and an account or password that fails
 * its rules, or a settings file that could not be read, as
 * `account-invalid`.
 * @remarks Reads and starts nothing until the registry asks.
 */
export function createEmailMcpServer(
  serverCommand: EmailServerCommand,
  readAccounts: () => Promise<EmailAccountsRead>
): BuiltInMcpServer {
  return Object.freeze({
    name: EMAIL_SERVER_NAME,
    transport: "stdio",
    readServer: async (): Promise<BuiltInMcpServerRead> => {
      /** Read of a built-in server whose account is not saved. */
      const accountMissing: BuiltInMcpServerRead = Object.freeze({
        status: "account-missing"
      })

      /** Read of a built-in server whose saved account is not usable. */
      const accountInvalid: BuiltInMcpServerRead = Object.freeze({
        status: "account-invalid"
      })

      const { person: read } = await readAccounts()
      switch (read.status) {
        case "read":
          return Object.freeze({
            status: "read",
            settings: buildEmailServerSettings(
              serverCommand,
              read.account,
              read.password
            )
          })
        case "missing":
          return accountMissing
        case "invalid":
        case "unreadable":
          return accountInvalid
      }
    }
  })
}

/**
 * Builds the settings that start the email server for one account.
 *
 * @param serverCommand - How the email server is run.
 * @param account - Account the server signs in with.
 * @param password - Its password.
 * @returns Frozen stdio settings named `email`, switched on, whose only
 * environment variable is {@link EMAIL_ACCOUNT_VARIABLE_NAME} holding the
 * account and the password; they pass the shared MCP server rules, as every
 * command the backend starts does.
 * @throws {z.ZodError} If the command fails the shared rules, such as a
 * path longer than a command may be, which the backend configuration
 * refuses first.
 */
export function buildEmailServerSettings(
  serverCommand: EmailServerCommand,
  account: EmailAccount,
  password: EmailPassword
): McpServerSettings {
  const accountVariable: McpEnvironmentVariable = {
    name: EMAIL_ACCOUNT_VARIABLE_NAME,
    value: buildEmailAccountVariable(account, password)
  }
  return mcpServerSettingsSchema.parse({
    name: EMAIL_SERVER_NAME,
    transport: "stdio",
    command: serverCommand.command,
    arguments: serverCommand.arguments,
    environment: [accountVariable],
    enabled: true
  })
}

/**
 * Builds the text the email server reads its account and password from.
 *
 * @param account - Account the server signs in with.
 * @param password - Its password.
 * @returns One line of JSON holding the account's fields and `password`;
 * a secret, which must reach the server's environment and nowhere else.
 * @remarks The rules of the account and the password refuse every control
 * character, so the line holds none, and its length stays within the limit
 * of an environment variable's value.
 */
export function buildEmailAccountVariable(
  account: EmailAccount,
  password: EmailPassword
): string {
  return JSON.stringify({
    address: account.address,
    displayName: account.displayName,
    userName: account.userName,
    password,
    imap: account.imap,
    smtp: account.smtp,
    serverKeepsSentCopy: account.serverKeepsSentCopy
  })
}
