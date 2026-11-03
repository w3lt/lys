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
// report that sign-in failed for the reason and the other accepted;
// `quit-failed` writes the real server's line about a closing QUIT that
// did not finish to standard error and reports both sign-ins accepted;
// `lines-<count>` writes that many lines, `line 1` onward, to standard
// error and reports both sign-ins accepted; `padded-<length>` reports both
// sign-ins accepted, padded with JSON white space so that it prints that
// many characters, its closing newline included; `hang` writes one line to
// standard error and never ends; `crash` writes two lines to standard error
// and exits with code 1; `garbage` prints a line that is not a report;
// `flood` prints far more than a report; `lock` holds `lock` in its folder
// while it waits, as a check that must run alone, and exits with code 3
// when another check holds it. It imports only Node's own modules and the
// fake stdio server.
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
 * Sends text to standard output, where the checker reads it, and exits
 * with code 0 once all of it is written.
 *
 * @param text - Text to print.
 * @remarks Exiting right after the write, as {@link sendCheckReport} does,
 * would cut a text longer than the pipe takes at once, 64 KiB on macOS.
 */
async function sendOutput(text: string): Promise<void> {
  await new Promise<void>((resolve) => {
    process.stdout.write(text, () => {
      resolve()
    })
  })
  process.exit(0)
}

/**
 * Builds the report of both sign-ins accepted, padded with JSON white space
 * after it.
 *
 * @param accepted - The outcome of an accepted sign-in.
 * @param length - Characters the text holds, its closing newline included;
 * a length the report does not fit in leaves it unpadded.
 * @returns The text.
 */
function buildPaddedCheckReport(accepted: unknown, length: number): string {
  const report = JSON.stringify({ imap: accepted, smtp: accepted })
  return `${report.padEnd(length - 1, " ")}\n`
}

/**
 * Builds lines to write to standard error.
 *
 * @param count - How many: `line 1` onward.
 * @returns The lines, each ended by a newline.
 */
function buildErrorLines(count: number): string {
  return Array.from(
    { length: count },
    (_, index) => `line ${index + 1}\n`
  ).join("")
}

/**
 * Parses the whole number a local part holds after its prefix, exiting
 * with code 64, as for an unknown address, when it holds none.
 *
 * @param localPart - The local part, such as `lines-33`.
 * @param prefix - What precedes the number, such as `lines-`.
 * @returns The number.
 */
function parseAddressNumber(localPart: string, prefix: string): number {
  const number = Number(localPart.slice(prefix.length))
  if (!Number.isSafeInteger(number) || number < 0) {
    process.stderr.write("unknown fake address\n")
    process.exit(64)
  }
  return number
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
 * for: here one whose local part carries a reason or a number, and any
 * other through {@link handleNamedCheckCommand}.
 *
 * @param address - Address of the account.
 */
async function handleCheckCommand(address: string): Promise<void> {
  const accepted = { status: "accepted" }
  const localPart = address.slice(0, address.indexOf("@"))
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
  if (localPart.startsWith("lines-")) {
    process.stderr.write(
      buildErrorLines(parseAddressNumber(localPart, "lines-"))
    )
    sendCheckReport(accepted, accepted)
  }
  if (localPart.startsWith("padded-"))
    await sendOutput(
      buildPaddedCheckReport(accepted, parseAddressNumber(localPart, "padded-"))
    )
  await handleNamedCheckCommand(localPart, accepted)
}

/**
 * Handles a check subcommand whose local part names the check, without a
 * reason or a number, by acting it out.
 *
 * @param localPart - Local part of the account's address.
 * @param accepted - The outcome of an accepted sign-in.
 */
async function handleNamedCheckCommand(
  localPart: string,
  accepted: unknown
): Promise<void> {
  switch (localPart) {
    case "accepted":
      sendCheckReport(accepted, accepted)
      break
    case "quit-failed":
      process.stderr.write(
        "smtp: quit did not finish within the check's limit\n"
      )
      sendCheckReport(accepted, accepted)
      break
    case "hang":
      process.stderr.write("connecting to the IMAP server\n")
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
      await sendOutput(`${"x".repeat(70_000)}\n`)
      break
    case "lock":
      await sendCheckReportUnderLock(accepted)
      break
    default:
      process.stderr.write("unknown fake address\n")
      process.exit(64)
  }
}

/**
 * Sends the report of both sign-ins accepted, and exits, once it held
 * `lock` in its folder for `holdMilliseconds`, as a check that must run
 * alone does; exits with code 3 when another check holds it.
 *
 * @param accepted - The outcome of an accepted sign-in.
 */
async function sendCheckReportUnderLock(accepted: unknown): Promise<void> {
  const lockPath = createLockFile()
  await wait(options.holdMilliseconds ?? 0)
  rmSync(lockPath)
  sendCheckReport(accepted, accepted)
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
