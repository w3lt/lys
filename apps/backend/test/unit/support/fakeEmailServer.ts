// A fake of the email server Lys ships, for tests, run directly by Node,
// which strips its types: `node fakeEmailServer.ts '<options JSON>' check`
// signs in as the real server's check subcommand does, and
// `node fakeEmailServer.ts '<options JSON>'` serves MCP as the fake stdio
// server does, with the same options. What it records goes to files of
// fixed names in the folder it runs in, never to a path its arguments
// name: `variable` holds the value of `LYS_EMAIL_ACCOUNT`, `pid` its
// process identifier. What the check does depends on the local part of
// the account's address, read from `LYS_EMAIL_ACCOUNT`: `accepted`
// reports both sign-ins accepted; `imap-<reason>` and `smtp-<reason>`
// report that sign-in failed for the reason and the other accepted; `hang`
// never ends; `crash` writes two lines to standard error and exits with
// code 1; `garbage` prints a line that is not a report; `flood` prints far
// more than a report; `lock` holds `lock` in its folder while it waits, as
// a check that must run alone, and exits with code 3 when another check
// holds it. It imports only Node's own modules and the fake stdio server.
import { rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as wait } from "node:timers/promises"

/** Module of the fake stdio MCP server, which serves MCP in the fake's place. */
const FAKE_STDIO_SERVER_URL = new URL(
  "./fakeMcpStdioServer.ts",
  import.meta.url
).href

/** What the fake does, from its first argument. */
type FakeEmailServerOptions = {
  /** Write the value of `LYS_EMAIL_ACCOUNT` to `variable` on start. */
  recordsVariable?: boolean
  /** Write the process identifier to `pid` on start. */
  recordsProcessId?: boolean
  /** How long the `lock` check holds `lock`. */
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
if (options.recordsVariable === true)
  writeFileSync(join(process.cwd(), "variable"), variable)
if (options.recordsProcessId === true)
  writeFileSync(join(process.cwd(), "pid"), String(process.pid))

if (subcommand === undefined) {
  await import(FAKE_STDIO_SERVER_URL)
} else if (subcommand === "check") {
  await handleCheckCommand((JSON.parse(variable) as FakeAccount).address)
} else {
  process.stderr.write(`unexpected subcommand ${subcommand}\n`)
  process.exit(64)
}

/**
 * Sends the report of both sign-ins to standard output, where the checker
 * reads it, and exits.
 *
 * @param imap - The IMAP sign-in's outcome.
 * @param smtp - The SMTP sign-in's outcome.
 */
function sendCheckReport(imap: unknown, smtp: unknown): void {
  process.stdout.write(`${JSON.stringify({ imap, smtp })}\n`)
  process.exit(0)
}

/**
 * Builds the outcome of a failed sign-in.
 *
 * @param reason - Why it failed.
 * @returns The outcome.
 */
function buildFailedSignIn(reason: string): unknown {
  return { status: "failed", reason }
}

/**
 * Handles the check subcommand by acting out the check the address asks
 * for.
 *
 * @param address - Address of the account.
 */
async function handleCheckCommand(address: string): Promise<void> {
  const accepted = { status: "accepted" }
  const localPart = address.slice(0, address.indexOf("@"))
  if (localPart === "accepted") sendCheckReport(accepted, accepted)
  if (localPart.startsWith("imap-"))
    sendCheckReport(
      buildFailedSignIn(localPart.slice("imap-".length)),
      accepted
    )
  if (localPart.startsWith("smtp-"))
    sendCheckReport(
      accepted,
      buildFailedSignIn(localPart.slice("smtp-".length))
    )
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
    case "lock": {
      const lockPath = createLockFile()
      await wait(options.holdMilliseconds ?? 0)
      rmSync(lockPath)
      sendCheckReport(accepted, accepted)
      break
    }
    default:
      process.stderr.write("unknown fake address\n")
      process.exit(64)
  }
}

/**
 * Creates `lock` in the folder the fake runs in, as a check that must run
 * alone does; exits with code 3 when another check holds it.
 *
 * @returns Path of the lock, which the caller removes.
 */
function createLockFile(): string {
  const lockPath = join(process.cwd(), "lock")
  try {
    writeFileSync(lockPath, String(process.pid), { flag: "wx" })
  } catch {
    process.stderr.write("another check runs\n")
    process.exit(3)
  }
  return lockPath
}
