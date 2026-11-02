import {
  emailServerCheckSchema,
  type CheckEmailAccountApiResponse,
  type EmailServerCheck
} from "@lys/protocol"
import type { EmailAccount, EmailPassword } from "@lys/share"
import { getDefaultEnvironment } from "@modelcontextprotocol/client/stdio"
import { spawn, type ChildProcess } from "node:child_process"
import * as z from "zod"
import McpServerLogLines from "../../mcpServerLogLines"
import {
  EMAIL_ACCOUNT_VARIABLE_NAME,
  EMAIL_SERVER_CHECK_SUBCOMMAND,
  formatEmailAccountVariable,
  type EmailServerCommand
} from "./emailServer"

/**
 * Longest one check may run before its process is killed: past two
 * sign-ins that each wait the email server's own connect and answer limits.
 */
export const EMAIL_ACCOUNT_CHECK_TIMEOUT_MILLISECONDS = 60_000

/**
 * Most characters of the check's standard output the checker reads; the
 * report is one short JSON line, so more is not a report.
 */
const MAXIMUM_OUTPUT_LENGTH = 65_536

/** Most standard error lines kept to log a failed check. */
const MAXIMUM_ERROR_LINE_COUNT = 32

/** Validates what the check subcommand prints: both sign-ins' outcomes. */
const checkOutputSchema = z
  .strictObject({
    imap: emailServerCheckSchema,
    smtp: emailServerCheckSchema
  })
  .readonly()

/**
 * Why a run of the email server's check did not report.
 *
 * @remarks `start-failed`: the process could not be started for a reason
 * other than a missing executable, such as a file that is not executable.
 * `timed-out`: it did not end within the time limit and was killed.
 * `exited`: it ended without reporting, with its exit code or the signal
 * that ended it. `unreadable-output`: it ended normally, but what it
 * printed is not a report. `closed`: the checker was closed before the
 * check ran, or killed the running check as it closed.
 */
export type EmailServerRunFailure =
  | Readonly<{
      kind: "start-failed"
      /** Node's error, which names the command and the subcommand. */
      error: Error
    }>
  | Readonly<{ kind: "timed-out" }>
  | Readonly<{
      kind: "exited"
      /** Exit code, or null when a signal ended the process. */
      exitCode: number | null
      /** Signal that ended the process, or null when it exited. */
      signal: NodeJS.Signals | null
      /** What it wrote to standard error, cut to a bound. */
      errorLines: readonly string[]
    }>
  | Readonly<{
      kind: "unreadable-output"
      /** What it wrote to standard error, cut to a bound. */
      errorLines: readonly string[]
    }>
  | Readonly<{ kind: "closed" }>

/**
 * Something about a check that its caller learns only by kind, reported
 * for the log.
 *
 * @remarks No event carries the account or the password. The error lines
 * a failure carries are the email server's own, which it writes without
 * the password, an address, a subject, or a body.
 */
export type EmailAccountCheckEvent =
  | Readonly<{
      /** The email server signed in to both servers and reported. */
      kind: "checked"
      /** Outcome of the IMAP sign-in. */
      imap: EmailServerCheck
      /** Outcome of the SMTP sign-in. */
      smtp: EmailServerCheck
    }>
  | Readonly<{
      /** The email server's executable is not where the configuration names it. */
      kind: "server-missing"
    }>
  | Readonly<{
      /** The email server ran, or was to run, but did not report. */
      kind: "server-failed"
      /** Why. */
      failure: EmailServerRunFailure
    }>

/** What a checker borrows for its lifetime. */
export type EmailAccountCheckerDependencies = Readonly<{
  /** How the email server is run; the checker adds the check subcommand. */
  serverCommand: EmailServerCommand
  /** Longest one check may run before its process is killed. */
  timeoutMilliseconds: number
  /** Receives every {@link EmailAccountCheckEvent}. */
  reportEvent: (event: EmailAccountCheckEvent) => void
}>

/** How one run of the check subcommand ended. */
type EmailServerRun =
  | Readonly<{
      /** The process ended, by exiting or by a signal. */
      status: "exited"
      /** Exit code, or null when a signal ended the process. */
      exitCode: number | null
      /** Signal that ended the process, or null when it exited. */
      signal: NodeJS.Signals | null
      /** What it printed; undefined when it printed more than is read. */
      output: string | undefined
      /** What it wrote to standard error, cut to a bound. */
      errorLines: readonly string[]
    }>
  | Readonly<{
      /** The process could not be started. */
      status: "start-failed"
      /** Node's error. */
      error: Error
    }>
  | Readonly<{
      /** The process was killed at the time limit. */
      status: "timed-out"
      /** What it wrote to standard error, cut to a bound. */
      errorLines: readonly string[]
    }>

/** Answer when the email server is not installed. */
const SERVER_MISSING: CheckEmailAccountApiResponse = Object.freeze({
  status: "unavailable",
  reason: "server-missing"
})

/** Answer when the email server did not report. */
const SERVER_FAILED: CheckEmailAccountApiResponse = Object.freeze({
  status: "unavailable",
  reason: "server-failed"
})

/** Failure of a check the closed checker did not run, or killed. */
const CLOSED_FAILURE: EmailServerRunFailure = Object.freeze({ kind: "closed" })

/** Failure of a check whose process was killed at the time limit. */
const TIMED_OUT_FAILURE: EmailServerRunFailure = Object.freeze({
  kind: "timed-out"
})

/**
 * Checks email accounts by running the email server's check subcommand,
 * one check at a time.
 *
 * @remarks Each check starts the email server with the account and the
 * password in its environment, waits for it to print its report, and
 * answers with the report, or with why there is none; nothing is saved.
 * Resource ownership: owns the process of the running check until it
 * ends, and kills it at the time limit or on {@link close}; a check that
 * runs when the backend is killed ends by itself at the email server's
 * own limits. Concurrency model: single-threaded; checks run one after
 * another in call order, so at most one email server process runs for
 * checks. {@link close} is idempotent.
 */
export default class EmailAccountChecker {
  /** Borrowed command, time limit, and reporter. */
  readonly #dependencies: EmailAccountCheckerDependencies
  /** Settles once every check asked for so far ended. */
  #checks: Promise<unknown>
  /** Process of the check running now, if any. */
  #runningProcess: ChildProcess | undefined
  /** Whether {@link close} was called. */
  #isClosed: boolean

  /**
   * Creates a checker that runs nothing yet.
   *
   * @param dependencies - Command, time limit, and reporter, borrowed for
   * the checker's lifetime.
   */
  public constructor(dependencies: EmailAccountCheckerDependencies) {
    this.#dependencies = dependencies
    this.#checks = Promise.resolve()
    this.#runningProcess = undefined
    this.#isClosed = false
  }

  /**
   * Signs in to the account's IMAP and SMTP servers through the email
   * server, once the checks asked for before ended.
   *
   * @param account - Account to sign in with.
   * @param password - Its password.
   * @returns The outcome of both sign-ins, or why no sign-in was tried:
   * `server-missing` when the email server's executable is not there, and
   * `server-failed` when it could not be started, ended without a report,
   * did not end within the time limit, or the checker is closed. It never
   * rejects.
   * @remarks Each run is reported to the log by its outcome, without the
   * account or the password.
   */
  public sendCheck(
    account: EmailAccount,
    password: EmailPassword
  ): Promise<CheckEmailAccountApiResponse> {
    const check = this.#checks.then(() => this.#runCheck(account, password))
    this.#checks = Promise.allSettled([check])
    return check
  }

  /**
   * Kills the running check, if any, and runs no later check.
   *
   * @returns A promise that settles once every check asked for so far
   * ended; every later call does the same.
   */
  public async close(): Promise<void> {
    this.#isClosed = true
    this.#runningProcess?.kill("SIGKILL")
    await this.#checks
  }

  /**
   * Runs one check now.
   *
   * @param account - Account to sign in with.
   * @param password - Its password.
   * @returns The answer as {@link sendCheck} describes.
   */
  async #runCheck(
    account: EmailAccount,
    password: EmailPassword
  ): Promise<CheckEmailAccountApiResponse> {
    if (this.#isClosed) return this.#reportFailure(CLOSED_FAILURE)
    const run = await runEmailServerCheck(
      this.#dependencies.serverCommand,
      formatEmailAccountVariable(account, password),
      this.#dependencies.timeoutMilliseconds,
      (process) => {
        this.#runningProcess = process
      }
    )
    switch (run.status) {
      case "start-failed":
        return this.#handleStartFailure(run.error)
      case "timed-out":
        return this.#reportFailure(TIMED_OUT_FAILURE)
      case "exited":
        return this.#handleExit(run)
    }
  }

  /**
   * Answers a check whose process could not be started.
   *
   * @param error - Node's error.
   * @returns `server-missing` for a missing executable, else
   * `server-failed`.
   */
  #handleStartFailure(error: Error): CheckEmailAccountApiResponse {
    if (isMissingExecutable(error)) {
      this.#dependencies.reportEvent({ kind: "server-missing" })
      return SERVER_MISSING
    }
    return this.#reportFailure(Object.freeze({ kind: "start-failed", error }))
  }

  /**
   * Answers a check whose process ended.
   *
   * @param run - How it ended and what it printed.
   * @returns The report it printed, or `server-failed` when it was killed
   * by {@link close}, ended with another exit code than 0, or printed
   * something else than a report.
   */
  #handleExit(
    run: Extract<EmailServerRun, { status: "exited" }>
  ): CheckEmailAccountApiResponse {
    if (this.#isClosed && run.signal !== null)
      return this.#reportFailure(CLOSED_FAILURE)
    if (run.exitCode !== 0)
      return this.#reportFailure(
        Object.freeze({
          kind: "exited",
          exitCode: run.exitCode,
          signal: run.signal,
          errorLines: run.errorLines
        })
      )
    const report = parseCheckOutput(run.output)
    if (report === undefined)
      return this.#reportFailure(
        Object.freeze({ kind: "unreadable-output", errorLines: run.errorLines })
      )
    this.#dependencies.reportEvent({
      kind: "checked",
      imap: report.imap,
      smtp: report.smtp
    })
    return Object.freeze({
      status: "checked",
      imap: report.imap,
      smtp: report.smtp
    })
  }

  /**
   * Reports why a check did not report, and answers `server-failed`.
   *
   * @param failure - Why.
   * @returns The `server-failed` answer.
   */
  #reportFailure(failure: EmailServerRunFailure): CheckEmailAccountApiResponse {
    this.#dependencies.reportEvent({ kind: "server-failed", failure })
    return SERVER_FAILED
  }
}

/**
 * Runs the email server's check subcommand once.
 *
 * @param serverCommand - How the email server is run.
 * @param accountVariableValue - Value of the account variable: the account
 * and the password as the server reads them.
 * @param timeoutMilliseconds - Longest the process may run before it is
 * killed.
 * @param trackProcess - Receives the process once started, and undefined
 * once it ended, so the caller can kill it meanwhile.
 * @returns A promise of how the run ended; it never rejects.
 * @remarks The process runs in the backend's default environment for MCP
 * servers, with the account variable added, and reads nothing from its
 * standard input. Its standard output is read up to a bound, and its
 * standard error line by line up to a bound, each line cut as a server's
 * log line is.
 */
function runEmailServerCheck(
  serverCommand: EmailServerCommand,
  accountVariableValue: string,
  timeoutMilliseconds: number,
  trackProcess: (process: ChildProcess | undefined) => void
): Promise<EmailServerRun> {
  return new Promise((resolve) => {
    const child = spawn(
      serverCommand.command,
      [...serverCommand.arguments, EMAIL_SERVER_CHECK_SUBCOMMAND],
      {
        env: {
          ...getDefaultEnvironment(),
          [EMAIL_ACCOUNT_VARIABLE_NAME]: accountVariableValue
        },
        stdio: ["ignore", "pipe", "pipe"]
      }
    )
    trackProcess(child)
    const errorLines: string[] = []
    const errorLineReader = new McpServerLogLines((line) => {
      if (errorLines.length < MAXIMUM_ERROR_LINE_COUNT) errorLines.push(line)
    })
    let output: string | undefined = ""
    let hasTimedOut = false
    let hasEnded = false
    const end = (run: EmailServerRun): void => {
      if (hasEnded) return
      hasEnded = true
      clearTimeout(timer)
      trackProcess(undefined)
      resolve(run)
    }
    const timer = setTimeout(() => {
      hasTimedOut = true
      child.kill("SIGKILL")
    }, timeoutMilliseconds)
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      if (output === undefined) return
      output =
        output.length + chunk.length > MAXIMUM_OUTPUT_LENGTH
          ? undefined
          : output + chunk
    })
    child.stderr.on("data", (chunk: Uint8Array) => {
      errorLineReader.read(chunk)
    })
    child.once("error", (error) => {
      end(Object.freeze({ status: "start-failed", error }))
    })
    child.once("close", (exitCode, signal) => {
      end(
        hasTimedOut
          ? Object.freeze({
              status: "timed-out",
              errorLines: Object.freeze([...errorLines])
            })
          : Object.freeze({
              status: "exited",
              exitCode,
              signal,
              output,
              errorLines: Object.freeze([...errorLines])
            })
      )
    })
  })
}

/**
 * Parses the report the check subcommand printed.
 *
 * @param output - What it printed, or undefined when it printed more than
 * is read.
 * @returns Both sign-ins' outcomes, or undefined when the output is not
 * one JSON report.
 */
function parseCheckOutput(
  output: string | undefined
): z.infer<typeof checkOutputSchema> | undefined {
  if (output === undefined) return undefined
  try {
    const parsed = checkOutputSchema.safeParse(JSON.parse(output))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

/**
 * Answers whether Node could not start the process because its executable
 * is missing.
 *
 * @param error - Node's error.
 * @returns True for the `ENOENT` code.
 */
function isMissingExecutable(error: Error): boolean {
  return "code" in error && error.code === "ENOENT"
}
