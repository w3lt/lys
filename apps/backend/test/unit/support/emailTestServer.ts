import {
  emailAccountSchema,
  emailPasswordSchema,
  type EmailAccount,
  type EmailPassword,
  type EmailServerSettings
} from "@lys/share"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { EmailServerCommand } from "../../../src/modules/mcp/builtIn/email/emailServer"
import type { FakeEmailServerOptions } from "./fakeEmailServer"

/** Path of the fake email server script. */
const FAKE_EMAIL_SERVER_PATH = fileURLToPath(
  new URL("./fakeEmailServer.ts", import.meta.url)
)

export type { FakeEmailServerOptions }

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
 * Reads the value of `LYS_EMAIL_ACCOUNT` a fake email server recorded.
 *
 * @param folder - Folder the fake ran in.
 * @returns The value, parsed as JSON.
 * @throws If the fake recorded nothing there, or the value is not JSON.
 */
export async function readRecordedEmailVariable(
  folder: string
): Promise<unknown> {
  return JSON.parse(await readFile(join(folder, "variable"), "utf8"))
}

/**
 * Reads the process identifier a fake email server recorded.
 *
 * @param folder - Folder the fake ran in.
 * @returns The identifier.
 * @throws If the fake recorded nothing there yet.
 */
export async function readRecordedEmailProcessId(
  folder: string
): Promise<number> {
  return Number(await readFile(join(folder, "pid"), "utf8"))
}

/**
 * Builds an account whose address selects what the fake email server does.
 *
 * @param address - Address of the account.
 * @returns A validated account at `example.com` servers over TLS.
 */
export function buildEmailAccount(address: string): EmailAccount {
  const imap: EmailServerSettings = {
    host: "imap.example.com",
    port: 993,
    security: "tls"
  }
  const smtp: EmailServerSettings = {
    host: "smtp.example.com",
    port: 465,
    security: "tls"
  }
  return emailAccountSchema.parse({
    address,
    displayName: "Test Person",
    userName: address,
    imap,
    smtp,
    serverKeepsSentCopy: false
  })
}
