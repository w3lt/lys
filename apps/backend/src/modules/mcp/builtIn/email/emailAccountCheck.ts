import {
  emailServerCheckSchema,
  type CheckEmailAccountApiResponse,
  type EmailServerCheck
} from "@lys/protocol"
import type { EmailAccount, EmailPassword } from "@lys/share"
import { getDefaultEnvironment } from "@modelcontextprotocol/client/stdio"
import { spawn, type ChildProcess } from "node:child_process"
import type { Readable } from "node:stream"
import * as z from "zod"
import { isSpawnFailure } from "../../mcpError"
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

/** Most standard error lines kept to log with a check's outcome. */
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
      /** Node's error, which can name the command and the subcommand. */
      error: Error
    }>
  | Readonly<{
      kind: "timed-out"
      /** What it wrote to standard error before it was killed, cut to a bound. */
      errorLines: readonly string[]
    }>
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
 * a report or a failure carries are the email server's own, which it
 * writes without the password, an address, a subject, or a body.
 */
export type EmailAccountCheckEvent =
  | Readonly<{
      /** The email server signed in to both servers and reported. */
      kind: "checked"
      /** Outcome of the IMAP sign-in. */
      imap: EmailServerCheck
      /** Outcome of the SMTP sign-in. */
      smtp: EmailServerCheck
      /**
       * What it wrote to standard error, cut to a bound, such as a closing
       * QUIT that failed after an accepted sign-in; empty when it wrote
       * nothing.
       */
      errorLines: readonly string[]
    }>
  | Readonly<{
      /** The email server's executable is not where the configuration names it. */
      kind: "server-missing"
    }>
  | Readonly<{
      /**
       * A check was asked for while another ran, so it was answered `busy`
       * without running.
       */
      kind: "busy"
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
  /**
   * Folder each check's process starts in: the folder every stdio MCP
   * server starts in, such as the person's home folder. A folder that does
   * not exist fails the start as a missing executable does, because Node
   * reports both as `ENOENT`.
   */
  workingDirectory: string
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

/** How one run of the check subcommand starts, and how long it may run. */
type EmailServerCheckStart = Readonly<{
  /** How the email server is run; the check subcommand is added. */
  serverCommand: EmailServerCommand
  /** Folder the process starts in. */
  workingDirectory: string
  /**
   * Value of the account variable: the account and the password as the
   * server reads them.
   */
  accountVariableValue: string
  /** Longest the process may run before it is killed. */
  timeoutMilliseconds: number
}>

/**
 * Process of one check: standard input ignored, the other two piped.
 *
 * @remarks Node's types promise both pipes, but Node returns the process
 * without them when it finds no file descriptor for them (`EMFILE` or
 * `ENFILE`), and reports that as an `error` event on the next tick.
 */
type CheckChildProcess = Omit<
  ChildProcess,
  "stdin" | "stdout" | "stderr" | "stdio"
> &
  Readonly<{
    /** Its standard output, unless Node found no file descriptor for it. */
    stdout: Readable | undefined
    /** Its standard error, unless Node found no file descriptor for it. */
    stderr: Readable | undefined
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

/** Answer when another check runs. */
const BUSY: CheckEmailAccountApiResponse = Object.freeze({
  status: "unavailable",
  reason: "busy"
})

/** Failure of a check the closed checker did not run, or killed. */
const CLOSED_FAILURE: EmailServerRunFailure = Object.freeze({ kind: "closed" })

/**
 * Checks email accounts by running the email server's check subcommand,
 * one check at a time.
 *
 * @remarks Each check starts the email server with the account and the
 * password in its environment, waits for it to print its report, and
 * answers with the report, or with why there is none; nothing is saved.
 * Each check starts in the folder MCP servers start in. Resource
 * ownership: owns the run of the check running now until it ends, which
 * kills its process at the time limit, and stops it on {@link close}; a
 * check that runs when the backend is killed ends by itself at the email
 * server's own limits. Concurrency model: one check at a time, without a
 * queue; a check asked for while another runs is answered `busy` at once
 * and keeps neither the account nor the password, so at most one email
 * server process runs for checks. {@link close} is idempotent.
 */
export default class EmailAccountChecker {
  /** Borrowed command, folder, time limit, and reporter. */
  readonly #dependencies: EmailAccountCheckerDependencies
  /** Run of the check running now, if any; owned. */
  #runningCheck: EmailServerCheckRun | undefined
  /** Whether {@link close} was called. */
  #isClosed: boolean

  /**
   * Creates a checker that runs nothing yet.
   *
   * @param dependencies - Command, folder, time limit, and reporter,
   * borrowed for the checker's lifetime.
   */
  public constructor(dependencies: EmailAccountCheckerDependencies) {
    this.#dependencies = dependencies
    this.#runningCheck = undefined
    this.#isClosed = false
  }

  /**
   * Signs in to the account's IMAP and SMTP servers through the email
   * server, unless another check runs.
   *
   * @param account - Account to sign in with.
   * @param password - Its password.
   * @returns The outcome of both sign-ins, or why no sign-in was tried:
   * `busy`, at once, when another check runs; `server-missing` when the
   * email server's executable is not there; and `server-failed` when it
   * could not be started, ended without a report, did not end within the
   * time limit, or the checker is closed, even while a check runs. It never
   * rejects.
   * @remarks Each run is reported to the log by its outcome, and so is a
   * check answered `busy`, without the account or the password.
   */
  public async sendCheck(
    account: EmailAccount,
    password: EmailPassword
  ): Promise<CheckEmailAccountApiResponse> {
    if (this.#isClosed) return this.#handleFailedRun(CLOSED_FAILURE)
    if (this.#runningCheck !== undefined) return this.#handleBusyCheck()
    const check = EmailServerCheckRun.start({
      serverCommand: this.#dependencies.serverCommand,
      workingDirectory: this.#dependencies.workingDirectory,
      accountVariableValue: formatEmailAccountVariable(account, password),
      timeoutMilliseconds: this.#dependencies.timeoutMilliseconds
    })
    this.#runningCheck = check
    const run = await check.waitForEnd()
    this.#runningCheck = undefined
    switch (run.status) {
      case "start-failed":
        return this.#handleStartFailure(run.error)
      case "timed-out":
        return this.#handleFailedRun(
          Object.freeze({ kind: "timed-out", errorLines: run.errorLines })
        )
      case "exited":
        return this.#handleExit(run)
    }
  }

  /**
   * Kills the running check, if any, and runs no later check.
   *
   * @returns A promise that settles once the check running now, if any,
   * ended; every later call does the same.
   */
  public async close(): Promise<void> {
    this.#isClosed = true
    await this.#runningCheck?.stop()
  }

  /**
   * Answers a check asked for while another runs: reports it, and answers
   * `busy` without running it.
   *
   * @returns The `busy` answer.
   */
  #handleBusyCheck(): CheckEmailAccountApiResponse {
    this.#dependencies.reportEvent({ kind: "busy" })
    return BUSY
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
    return this.#handleFailedRun(Object.freeze({ kind: "start-failed", error }))
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
      return this.#handleFailedRun(CLOSED_FAILURE)
    if (run.exitCode !== 0)
      return this.#handleFailedRun(
        Object.freeze({
          kind: "exited",
          exitCode: run.exitCode,
          signal: run.signal,
          errorLines: run.errorLines
        })
      )
    const report = parseCheckOutput(run.output)
    if (report === undefined)
      return this.#handleFailedRun(
        Object.freeze({ kind: "unreadable-output", errorLines: run.errorLines })
      )
    this.#dependencies.reportEvent({
      kind: "checked",
      imap: report.imap,
      smtp: report.smtp,
      errorLines: run.errorLines
    })
    return Object.freeze({
      status: "checked",
      imap: report.imap,
      smtp: report.smtp
    })
  }

  /**
   * Handles a run that did not report: reports why, and answers
   * `server-failed`.
   *
   * @param failure - Why.
   * @returns The `server-failed` answer.
   */
  #handleFailedRun(
    failure: EmailServerRunFailure
  ): CheckEmailAccountApiResponse {
    this.#dependencies.reportEvent({ kind: "server-failed", failure })
    return SERVER_FAILED
  }
}

/**
 * Owns one run of the email server's check subcommand: its process, and
 * what the process printed so far.
 *
 * @remarks Created by {@link EmailServerCheckRun.start}. The process runs
 * in the backend's default environment for MCP servers, with the account
 * variable added, and reads nothing from its standard input. Its standard
 * output is read up to a bound, and its standard error line by line up to
 * a bound, each line cut as a server's log line is. Resource ownership:
 * owns the process, if Node started one, until it ends; Node kills it with
 * `SIGKILL` once the time limit passed, and {@link stop} kills it before.
 * Concurrency model: single-owner; the checker starts and stops it, and
 * the process's events reach it on the backend's event loop.
 */
class EmailServerCheckRun {
  /**
   * The check's process, owned until it ends; undefined when Node threw
   * because it could not start one.
   */
  readonly #child: CheckChildProcess | undefined
  /** Aborts once the time limit passed, when Node kills the process. */
  readonly #timeLimit: AbortSignal
  /** Settles once, with how the run ended. */
  readonly #ending: PromiseWithResolvers<EmailServerRun>
  /** Standard error lines kept for the log, up to a bound. */
  readonly #errorLines: string[]
  /** Reads standard error into the kept lines. */
  readonly #errorLineReader: McpServerLogLines
  /** What the process printed so far; undefined once it printed more than is read. */
  #output: string | undefined

  /**
   * Keeps a process that was started, of which nothing was read yet, or
   * no process.
   *
   * @param child - The started process, owned from here on; undefined when
   * Node threw because it could not start one.
   * @param timeLimit - Signal that aborts once the time limit passed.
   */
  private constructor(
    child: CheckChildProcess | undefined,
    timeLimit: AbortSignal
  ) {
    this.#child = child
    this.#timeLimit = timeLimit
    this.#ending = Promise.withResolvers()
    const errorLines: string[] = []
    this.#errorLines = errorLines
    this.#errorLineReader = new McpServerLogLines((line) => {
      addErrorLine(errorLines, line)
    })
    this.#output = ""
  }

  /**
   * Starts the check subcommand in a process of its own.
   *
   * @param start - The command, folder, account variable, and time limit.
   * @returns The run, whose output it reads from here on.
   * @throws Node's refusal of the command's arguments, such as a text that
   * holds a NUL character, before any process is started; a command that
   * cannot be started, even for lack of file descriptors, ends the run as
   * `start-failed` instead.
   */
  public static start(start: EmailServerCheckStart): EmailServerCheckRun {
    const timeLimit = AbortSignal.timeout(start.timeoutMilliseconds)
    const started = startCheckProcess(start, timeLimit)
    if (started instanceof Error)
      return EmailServerCheckRun.#createStartFailedRun(started, timeLimit)
    const run = new EmailServerCheckRun(started, timeLimit)
    started.stdout?.setEncoding("utf8")
    started.stdout?.on("data", (chunk: string) => {
      run.#readOutput(chunk)
    })
    started.stderr?.on("data", (chunk: Uint8Array) => {
      run.#errorLineReader.read(chunk)
    })
    started.on("error", (error) => {
      run.#handleError(error)
    })
    started.once("close", (exitCode, signal) => {
      run.#handleClose(exitCode, signal)
    })
    return run
  }

  /**
   * Creates a run that ended as `start-failed` without a process.
   *
   * @param error - The error Node threw because it could not start the
   * process.
   * @param timeLimit - Signal that aborts once the time limit passed.
   * @returns The run, already ended.
   */
  static #createStartFailedRun(
    error: Error,
    timeLimit: AbortSignal
  ): EmailServerCheckRun {
    const run = new EmailServerCheckRun(undefined, timeLimit)
    run.#ending.resolve(Object.freeze({ status: "start-failed", error }))
    return run
  }

  /**
   * Waits for the run to end.
   *
   * @returns A promise of how it ended, settled once the process ended or
   * could not be started; it never rejects.
   */
  public waitForEnd(): Promise<EmailServerRun> {
    return this.#ending.promise
  }

  /**
   * Kills the process with `SIGKILL`, if it still runs.
   *
   * @returns A promise that settles once the run ended; every later call
   * does the same.
   */
  public async stop(): Promise<void> {
    this.#child?.kill("SIGKILL")
    await this.#ending.promise
  }

  /**
   * Keeps what the process printed, up to the bound.
   *
   * @param chunk - Text it printed next.
   */
  #readOutput(chunk: string): void {
    if (this.#output === undefined) return
    this.#output =
      this.#output.length + chunk.length > MAXIMUM_OUTPUT_LENGTH
        ? undefined
        : this.#output + chunk
  }

  /**
   * Ends the run as `start-failed` when the process could not be started.
   *
   * @param error - Node's error.
   * @remarks Ignores the `AbortError` Node emits once it killed the
   * process at the time limit: the process's close then ends the run.
   */
  #handleError(error: Error): void {
    if (this.#timeLimit.aborted) return
    this.#ending.resolve(Object.freeze({ status: "start-failed", error }))
  }

  /**
   * Ends the run once the process ended and its streams closed.
   *
   * @param exitCode - Exit code, or null when a signal ended the process.
   * @param signal - Signal that ended the process, or null when it exited.
   * @remarks A process a signal ended after the time limit passed was
   * killed at the limit, and ends the run as `timed-out`.
   */
  #handleClose(exitCode: number | null, signal: NodeJS.Signals | null): void {
    const errorLines = Object.freeze([...this.#errorLines])
    this.#ending.resolve(
      this.#timeLimit.aborted && signal !== null
        ? Object.freeze({ status: "timed-out", errorLines })
        : Object.freeze({
            status: "exited",
            exitCode,
            signal,
            output: this.#output,
            errorLines
          })
    )
  }
}

/**
 * Starts the process of one check.
 *
 * @param start - The command, folder, account variable, and time limit.
 * @param timeLimit - Signal that aborts once the time limit passed, when
 * Node kills the process with `SIGKILL`.
 * @returns The process Node started, or the error Node threw because it
 * could not start one, such as for a path that goes through a file
 * (`ENOTDIR`). Node reports other failures to start, such as a missing
 * executable or no file descriptor left, after it returned the process, as
 * an `error` event.
 * @throws Node's refusal of the command's arguments, such as a text that
 * holds a NUL character.
 */
function startCheckProcess(
  start: EmailServerCheckStart,
  timeLimit: AbortSignal
): CheckChildProcess | Error {
  try {
    return spawn(
      start.serverCommand.command,
      [...start.serverCommand.arguments, EMAIL_SERVER_CHECK_SUBCOMMAND],
      {
        cwd: start.workingDirectory,
        env: {
          ...getDefaultEnvironment(),
          [EMAIL_ACCOUNT_VARIABLE_NAME]: start.accountVariableValue
        },
        stdio: ["ignore", "pipe", "pipe"],
        signal: timeLimit,
        killSignal: "SIGKILL"
      }
    )
  } catch (error) {
    if (error instanceof Error && isSpawnFailure(error)) return error
    throw error
  }
}

/**
 * Adds one standard error line of a check while fewer than the bound are
 * kept.
 *
 * @param errorLines - Lines kept so far, in order; the line is added to it.
 * @param line - The next line.
 */
function addErrorLine(errorLines: string[], line: string): void {
  if (errorLines.length < MAXIMUM_ERROR_LINE_COUNT) errorLines.push(line)
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
