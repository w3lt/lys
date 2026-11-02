import {
  emailAccountSchema,
  emailPasswordSchema,
  type EmailAccount,
  type EmailPassword
} from "@lys/share"
import { fileURLToPath } from "node:url"
import type { EmailServerCommand } from "../../../src/modules/mcp/builtIn/email/emailServer"

/** Path of the fake email server script. */
const FAKE_EMAIL_SERVER_PATH = fileURLToPath(
  new URL("./fakeEmailServer.ts", import.meta.url)
)

/** What the fake email server does; see the script. */
export type FakeEmailServerOptions = Readonly<{
  /** Write the value of `LYS_EMAIL_ACCOUNT` to this file on start. */
  recordFile?: string
  /** Write the process identifier to this file on start. */
  processIdFile?: string
  /** Lock file the `lock` check holds. */
  lockFile?: string
  /** How long the `lock` check holds its lock. */
  holdMilliseconds?: number
}>

/** Synthetic password standing in for a secret; not a real credential. */
export const SYNTHETIC_EMAIL_PASSWORD: EmailPassword =
  emailPasswordSchema.parse("synthetic-password-7f3a")

/**
 * Builds the command that runs the fake email server with Node.
 *
 * @param options - What the fake does.
 * @returns The command, to which the checker adds the subcommand.
 */
export function buildFakeEmailServerCommand(
  options: FakeEmailServerOptions = {}
): EmailServerCommand {
  return Object.freeze({
    command: process.execPath,
    arguments: Object.freeze([
      "--no-warnings",
      FAKE_EMAIL_SERVER_PATH,
      JSON.stringify(options)
    ])
  })
}

/**
 * Builds an account whose address selects what the fake email server does.
 *
 * @param address - Address of the account.
 * @returns A validated account at `example.com` servers over TLS.
 */
export function buildEmailAccount(address: string): EmailAccount {
  return emailAccountSchema.parse({
    address,
    displayName: "Test Person",
    userName: address,
    imap: { host: "imap.example.com", port: 993, security: "tls" },
    smtp: { host: "smtp.example.com", port: 465, security: "tls" },
    serverKeepsSentCopy: false
  })
}
