import type { McpServerList } from "@lys/protocol"
import {
  buildMcpToolNamePrefix,
  isBuiltInMcpServerOn,
  mcpServerSettingsSchema,
  type BuiltInMcpServerName,
  type BuiltInMcpSettings,
  type EmailAccount,
  type EmailAddress,
  type EmailPassword,
  type McpEnvironmentVariable,
  type McpServerSettings,
  type McpSettings
} from "@lys/share"
import type {
  EmailAccountRead,
  EmailAccountsRead
} from "../../../../infrastructure/settings/emailAccountFile"
import type {
  BuiltInMcpServer,
  BuiltInMcpServerProblem,
  BuiltInMcpServerRead
} from "../../mcpServerRegistry"

/** Name the email server is listed under, and its tools are prefixed with. */
export const EMAIL_SERVER_NAME = "email" satisfies BuiltInMcpServerName

/**
 * Start of the model-facing name of each tool of Lys's own mailbox: the
 * server's prefix, then the `lys_` the email server names those tools
 * with.
 */
const LYS_MAILBOX_TOOL_NAME_PREFIX = `${buildMcpToolNamePrefix(EMAIL_SERVER_NAME)}lys_`

/**
 * Environment variable the email server reads the person's account and
 * password from, and its account check the account to check, as the JSON
 * text {@link buildEmailAccountVariable} writes.
 */
export const EMAIL_ACCOUNT_VARIABLE_NAME = "LYS_EMAIL_ACCOUNT"

/**
 * Environment variable the email server reads Lys's own account and
 * password from, as the JSON text {@link buildEmailAccountVariable} writes.
 */
export const LYS_EMAIL_ACCOUNT_VARIABLE_NAME = "LYS_EMAIL_LYS_ACCOUNT"

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

/** One mailbox the email server serves, with what it signs in with. */
export type EmailServerMailbox = Readonly<{
  /** Environment variable the server reads the mailbox's account from. */
  variableName:
    typeof EMAIL_ACCOUNT_VARIABLE_NAME | typeof LYS_EMAIL_ACCOUNT_VARIABLE_NAME
  /** Account the server signs in with; personal data. */
  account: EmailAccount
  /** Its password; a secret. */
  password: EmailPassword
}>

/** One mailbox that is switched on, and the read of its saved account. */
type SwitchedOnMailbox = Readonly<{
  /** Environment variable the server would read the account from. */
  variableName: EmailServerMailbox["variableName"]
  /** Read of the mailbox's saved account and password. */
  read: EmailAccountRead
}>

/** Mailboxes of a read that serves none, as one whose account is unusable. */
const NO_MAILBOXES: readonly EmailServerMailbox[] = Object.freeze([])

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
 * The built-in email server the MCP server registry applies: one process
 * that serves the person's mailbox, Lys's own, or both, whichever the
 * settings switch on.
 *
 * Each read reads the saved accounts again and builds the settings that
 * start the server, and keeps the address of Lys's account while the read
 * serves her mailbox, which {@link EmailMcpServer.readLysEmailAddress}
 * gives while the registry lists the server as applied and on. Invariant:
 * the address kept is that of the last read that ended, or null when that
 * read did not serve Lys's mailbox or no read has ended. Concurrency model:
 * reads may overlap, and the one that ends last sets the address; the
 * registry applies settings one at a time, so its last read is the one it
 * applied. Resource ownership: owns no resource and starts nothing; it
 * borrows the command and the account reader for its lifetime.
 */
export class EmailMcpServer implements BuiltInMcpServer {
  /** Name it is listed under: `email`. */
  public readonly name = EMAIL_SERVER_NAME

  /** How the backend talks to it: over stdio. */
  public readonly transport = "stdio"

  /** How the email server is run; borrowed. */
  readonly #serverCommand: EmailServerCommand

  /** Reads the saved email accounts and their passwords again; borrowed. */
  readonly #readAccounts: () => Promise<EmailAccountsRead>

  /** Address of Lys's account while the last read served her mailbox. */
  #lysAddress: EmailAddress | null = null

  /**
   * Keeps how the server is run and how its accounts are read, without
   * reading or starting anything.
   * @param serverCommand - How the email server is run; borrowed for the
   * server's lifetime.
   * @param readAccounts - Reads the saved email accounts and their
   * passwords again; borrowed for the server's lifetime.
   */
  public constructor(
    serverCommand: EmailServerCommand,
    readAccounts: () => Promise<EmailAccountsRead>
  ) {
    this.#serverCommand = serverCommand
    this.#readAccounts = readAccounts
  }

  /**
   * Implements {@link BuiltInMcpServer.readServer} for the email server.
   * @param settings - The applied `mcp` group, whose `builtIn.email`
   * switches say which mailboxes the server serves; the registry reads the
   * server only while one is on.
   * @returns `read` with the settings {@link buildEmailServerSettings}
   * builds for each mailbox that is on, whose account and password are
   * saved and usable; else `account-invalid` when an account of a mailbox
   * that is on fails its rules, the two accounts are one mailbox, or the
   * settings file could not be read, and `account-missing` when such an
   * account is not saved. A mailbox that is off never puts its account or
   * password in the settings.
   * @throws {TypeError} If both mailboxes are off, which the registry never
   * reads; nothing is read then. The read's failure, which keeps the
   * address of the last read that ended.
   */
  public async readServer(
    settings: McpSettings
  ): Promise<BuiltInMcpServerRead> {
    if (!isBuiltInMcpServerOn(settings.builtIn, EMAIL_SERVER_NAME))
      throw new TypeError("The email server was read with both mailboxes off.")
    const accounts = await this.#readAccounts()
    const switchedOn = listSwitchedOnMailboxes(settings.builtIn.email, accounts)
    const problem = findMailboxProblem(switchedOn)
    const served =
      problem === undefined ? listServedMailboxes(switchedOn) : NO_MAILBOXES
    this.#lysAddress = findLysAddress(served)
    if (problem !== undefined) return Object.freeze({ status: problem })
    return Object.freeze({
      status: "read",
      settings: buildEmailServerSettings(this.#serverCommand, served)
    })
  }

  /**
   * Reads the address of Lys's own mailbox while the email server serves
   * it.
   * @param servers - The servers the registry applied, as it lists them
   * now.
   * @returns The address of Lys's account when the list holds the built-in
   * `email` server not switched off, and the last read served her mailbox;
   * else null, as when her mailbox is off, its account is unusable, or an
   * added server took the name `email`. The address is personal data.
   */
  public readLysEmailAddress(servers: McpServerList): EmailAddress | null {
    const applied = servers.servers.find(
      (server) => server.name === EMAIL_SERVER_NAME
    )
    const isServing =
      applied !== undefined &&
      applied.isBuiltIn &&
      applied.state.status !== "off"
    return isServing ? this.#lysAddress : null
  }

  /**
   * Implements {@link BuiltInMcpServer.isLysOnlyTool} for the email server.
   * @param toolName - Model-facing name of one of its tools.
   * @returns True for a tool of Lys's own mailbox, whose name begins with
   * `mcp__email__lys_`; false for a tool of the person's.
   */
  public isLysOnlyTool(toolName: string): boolean {
    return toolName.startsWith(LYS_MAILBOX_TOOL_NAME_PREFIX)
  }
}

/**
 * Lists the mailboxes the switches turn on, the person's first, each with
 * the read of its account.
 *
 * @param switches - The email server's mailbox switches.
 * @param accounts - The read of both saved accounts.
 * @returns The frozen list; empty when both mailboxes are off.
 */
function listSwitchedOnMailboxes(
  switches: BuiltInMcpSettings["email"],
  accounts: EmailAccountsRead
): readonly SwitchedOnMailbox[] {
  const mailboxes: SwitchedOnMailbox[] = []
  if (switches.enabled)
    mailboxes.push({
      variableName: EMAIL_ACCOUNT_VARIABLE_NAME,
      read: accounts.person
    })
  if (switches.lysEnabled)
    mailboxes.push({
      variableName: LYS_EMAIL_ACCOUNT_VARIABLE_NAME,
      read: accounts.lys
    })
  return Object.freeze(mailboxes)
}

/**
 * Finds why the mailboxes that are on cannot be served.
 *
 * @param mailboxes - The mailboxes that are on, with their reads.
 * @returns `account-invalid` when any account fails its rules or could not
 * be read, which a person must fix before anything else; else
 * `account-missing` when any account is not saved; else undefined.
 */
function findMailboxProblem(
  mailboxes: readonly SwitchedOnMailbox[]
): BuiltInMcpServerProblem | undefined {
  const statuses = new Set(mailboxes.map((mailbox) => mailbox.read.status))
  if (statuses.has("invalid") || statuses.has("unreadable"))
    return "account-invalid"
  return statuses.has("missing") ? "account-missing" : undefined
}

/**
 * Lists the mailboxes the server serves: those whose accounts read.
 *
 * @param mailboxes - The mailboxes that are on, with their reads.
 * @returns The frozen list, in the order given, of each mailbox whose
 * account and password are saved and usable.
 */
function listServedMailboxes(
  mailboxes: readonly SwitchedOnMailbox[]
): readonly EmailServerMailbox[] {
  return Object.freeze(
    mailboxes.flatMap(({ variableName, read }) =>
      read.status === "read"
        ? [
            Object.freeze({
              variableName,
              account: read.account,
              password: read.password
            })
          ]
        : []
    )
  )
}

/**
 * Finds the address of Lys's account among the mailboxes served.
 *
 * @param mailboxes - The mailboxes the server serves.
 * @returns Her address, or null when her mailbox is not among them.
 */
function findLysAddress(
  mailboxes: readonly EmailServerMailbox[]
): EmailAddress | null {
  const lys = mailboxes.find(
    (mailbox) => mailbox.variableName === LYS_EMAIL_ACCOUNT_VARIABLE_NAME
  )
  return lys === undefined ? null : lys.account.address
}

/**
 * Builds the settings that start the email server for its mailboxes.
 *
 * @param serverCommand - How the email server is run.
 * @param mailboxes - The mailboxes it serves, each variable once.
 * @returns Frozen stdio settings named `email`, switched on, whose
 * environment holds one variable per mailbox, in the order given, with its
 * account and password; they pass the shared MCP server rules, as every
 * command the backend starts does.
 * @throws {z.ZodError} If the command fails the shared rules, such as a
 * path longer than a command may be, which the backend configuration
 * refuses first.
 */
export function buildEmailServerSettings(
  serverCommand: EmailServerCommand,
  mailboxes: readonly EmailServerMailbox[]
): McpServerSettings {
  const environment: McpEnvironmentVariable[] = mailboxes.map(
    ({ variableName, account, password }) => ({
      name: variableName,
      value: buildEmailAccountVariable(account, password)
    })
  )
  return mcpServerSettingsSchema.parse({
    name: EMAIL_SERVER_NAME,
    transport: "stdio",
    command: serverCommand.command,
    arguments: serverCommand.arguments,
    environment,
    enabled: true
  })
}

/**
 * Builds the text the email server reads an account and its password from.
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
