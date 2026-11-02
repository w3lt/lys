// A fake of the email server Lys ships, for tests, run directly by Node,
// which strips its types: `node fakeEmailServer.ts '<options JSON>' check`
// signs in as the real server's check subcommand does, and
// `node fakeEmailServer.ts '<options JSON>'` serves MCP as the fake stdio
// server does, with the same options. What the check does depends on the
// local part of the account's address, read from `LYS_EMAIL_ACCOUNT`:
// `accepted` reports both sign-ins accepted; `imap-<reason>` and
// `smtp-<reason>` report that sign-in failed for the reason and the other
// accepted; `hang` never ends; `crash` writes two lines to standard error
// and exits with code 1; `garbage` prints a line that is not a report;
// `flood` prints far more than a report; `lock` holds the lock file while
// it waits, as a check that must run alone, and exits with code 3 when the
// file exists. It imports only Node's own modules and the fake stdio server.
import { existsSync, rmSync, writeFileSync } from "node:fs"
import { setTimeout as wait } from "node:timers/promises"

/** Module of the fake stdio MCP server, which serves MCP in the fake's place. */
const FAKE_STDIO_SERVER_URL = new URL(
  "./fakeMcpStdioServer.ts",
  import.meta.url
).href

/** What the fake does, from its first argument. */
type FakeEmailServerOptions = {
  /** Write the value of `LYS_EMAIL_ACCOUNT` to this file on start. */
  recordFile?: string
  /** Write the process identifier to this file on start. */
  processIdFile?: string
  /** Lock file the `lock` check holds. */
  lockFile?: string
  /** How long the `lock` check holds its lock. */
  holdMilliseconds?: number
}

/** The account the fake was started with, as far as it reads it. */
type FakeAccount = {
  address: string
}

const options = JSON.parse(process.argv[2] ?? "{}") as FakeEmailServerOptions
const subcommand = process.argv[3]
const variable = process.env.LYS_EMAIL_ACCOUNT

if (variable === undefined) {
  process.stderr.write("LYS_EMAIL_ACCOUNT is not set\n")
  process.exit(2)
}
if (options.recordFile !== undefined)
  writeFileSync(options.recordFile, variable)
if (options.processIdFile !== undefined)
  writeFileSync(options.processIdFile, String(process.pid))

if (subcommand === undefined) {
  await import(FAKE_STDIO_SERVER_URL)
} else if (subcommand === "check") {
  await runCheck((JSON.parse(variable) as FakeAccount).address)
} else {
  process.stderr.write(`unexpected subcommand ${subcommand}\n`)
  process.exit(64)
}

/**
 * Prints the report of both sign-ins and exits.
 *
 * @param imap - The IMAP sign-in's outcome.
 * @param smtp - The SMTP sign-in's outcome.
 */
function report(imap: unknown, smtp: unknown): void {
  process.stdout.write(`${JSON.stringify({ imap, smtp })}\n`)
  process.exit(0)
}

/**
 * Builds the outcome of a failed sign-in.
 *
 * @param reason - Why it failed.
 * @returns The outcome.
 */
function failed(reason: string): unknown {
  return { status: "failed", reason }
}

/**
 * Runs the check the address asks for.
 *
 * @param address - Address of the account.
 */
async function runCheck(address: string): Promise<void> {
  const accepted = { status: "accepted" }
  const localPart = address.slice(0, address.indexOf("@"))
  if (localPart === "accepted") report(accepted, accepted)
  if (localPart.startsWith("imap-"))
    report(failed(localPart.slice("imap-".length)), accepted)
  if (localPart.startsWith("smtp-"))
    report(accepted, failed(localPart.slice("smtp-".length)))
  switch (localPart) {
    case "hang":
      setInterval(() => undefined, 1000)
      return
    case "crash":
      process.stderr.write("connecting to the IMAP server\n")
      process.stderr.write("unexpected failure: boom\n")
      process.exit(1)
      break
    case "garbage":
      process.stdout.write("not a report\n")
      process.exit(0)
      break
    case "flood":
      process.stdout.write(`${"x".repeat(70_000)}\n`)
      process.exit(0)
      break
    case "lock":
      await holdLock()
      report(accepted, accepted)
      break
    default:
      process.stderr.write("unknown fake address\n")
      process.exit(64)
  }
}

/**
 * Holds the lock file while waiting, as a check that must run alone; exits
 * with code 3 when another check holds it.
 */
async function holdLock(): Promise<void> {
  const { lockFile } = options
  if (lockFile === undefined) throw new Error("No lock file was given.")
  if (existsSync(lockFile)) {
    process.stderr.write("another check runs\n")
    process.exit(3)
  }
  writeFileSync(lockFile, String(process.pid))
  await wait(options.holdMilliseconds ?? 0)
  rmSync(lockFile)
}
