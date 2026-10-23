import type { EventEmitter } from "node:events"
import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import type { Writable } from "node:stream"
import type { FastifyBaseLogger } from "fastify"
import { pino, type DestinationStream } from "pino"

/** The `level` field of a log line, holding the level's name. */
type LogLevelField = Readonly<{
  /** Name of the line's level, such as `info` or `error`. */
  level: string
}>

/** Name of a backend output, as its failure report states it. */
type BackendOutputName = "standard output" | "standard error" | "log file"

/**
 * Creates the backend's logger, at level `info`.
 *
 * Each line is one JSON object whose `level` is the level's name, such as
 * `"info"`, and whose `time` is the UTC ISO-8601 time of the line. An
 * application built with this logger also logs each request, with its full
 * URL, query string included, such as a history search, and a request for a
 * route that does not exist gets a line of its own.
 *
 * @param destination - Receives each line, newline included, through a
 * synchronous `write` that must not throw; owned by the caller, which handles
 * its write failures, as {@link BackendLogDestination} does. The logger never
 * ends or closes it.
 * @returns A new logger that writes lines at level `info` and above, and leaves
 * out `debug` and `trace` lines.
 */
export function createBackendLogger(
  destination: DestinationStream
): FastifyBaseLogger {
  return pino(
    {
      level: "info",
      formatters: { level: buildLogLevelField },
      timestamp: formatLogTimeField
    },
    destination
  )
}

/**
 * Builds the `level` field of a log line from the level's name, so the line
 * names its level instead of pino's number.
 *
 * @param label - Name of the line's level, such as `info`.
 * @returns The field.
 */
function buildLogLevelField(label: string): LogLevelField {
  return Object.freeze({ level: label })
}

/**
 * Formats the `time` field of a log line from the current time.
 *
 * @returns The field as pino inserts it into the line: a comma, then
 * `"time":` and the UTC ISO-8601 time with milliseconds as a JSON string.
 */
function formatLogTimeField(): string {
  return `,"time":"${new Date().toISOString()}"`
}

/**
 * Names the backend's log file for the UTC day of a moment.
 *
 * @param now - Moment whose UTC date names the file.
 * @returns `backend-YYYY-MM-DD.log`, such as `backend-2026-10-21.log`.
 */
function formatLogFileName(now: Date): string {
  return `backend-${now.toISOString().slice(0, 10)}.log`
}

/**
 * Creates the backend's logs directory unless it already exists. Its parent,
 * the Lys home, is never created, so a Lys home that is missing stays
 * missing.
 *
 * @param logsDirectoryPath - Absolute path of the logs directory.
 * @throws The failure of creating the directory, such as `ENOENT` when the
 * Lys home is missing; not `EEXIST`, which means the directory, or a file
 * in its place, is already there.
 */
function createLogsDirectory(logsDirectoryPath: string): void {
  try {
    mkdirSync(logsDirectoryPath)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return
    }
    throw error
  }
}

/**
 * Owns where the backend's log lines go: each line is written to the
 * backend's standard output and appended to the log file of the UTC day on
 * which it is written, `backend-YYYY-MM-DD.log` in the logs directory, so
 * each day has one file. It serves as the destination of the backend's
 * logger.
 *
 * @remarks Invariant: a line is appended only to the file named by the UTC
 * date read as that line is written, so a running backend moves to the next
 * day's file with its first line after midnight UTC, and no file is ever
 * removed or rewritten. The logs directory is created whenever it is missing,
 * but never the Lys home that holds it, and a day's file is created with that
 * day's first line; a new file is readable and
 * writable by its owner only, and an existing file keeps its permissions. A
 * line that cannot be appended, such as on a full disk, is lost from the
 * files, or only its start is kept when the disk fills partway through it;
 * only the first such failure is reported, on standard error, and later
 * lines are appended again once writing works.
 * Resource ownership: borrows both standard streams from the process; opens
 * the day's file for each line and closes it before that line's write
 * returns, so it keeps no handle and has nothing to release.
 * Concurrency model: single-owner; the backend entry point retains the
 * instance on the backend's one event loop, and every write is synchronous.
 */
export class BackendLogDestination {
  /** Receives every line; borrowed from the process. */
  readonly #standardOutput: Writable
  /** Absolute path of the directory that holds the day files. */
  readonly #logsDirectoryPath: string
  /** Reports the first failure to append a line; owned. */
  readonly #fileFailureReporter: OutputFailureReporter

  /**
   * Creates a destination that has written nothing yet, without touching the
   * disk.
   *
   * @param standardOutput - The backend's standard output, which receives
   * every line; borrowed. Its own write failures are reported through its
   * `error` event, as {@link registerOutputFailureListeners} handles them.
   * @param standardError - The backend's standard error, which receives the
   * report of the first line that could not be appended; borrowed.
   * @param logsDirectoryPath - Absolute path of the directory that holds the
   * day files.
   */
  public constructor(
    standardOutput: Writable,
    standardError: Writable,
    logsDirectoryPath: string
  ) {
    this.#standardOutput = standardOutput
    this.#logsDirectoryPath = logsDirectoryPath
    this.#fileFailureReporter = new OutputFailureReporter(
      "log file",
      standardError
    )
  }

  /**
   * Writes one line to the standard output, then appends it to the file of
   * the current UTC day, creating the logs directory and the file when they
   * are missing.
   *
   * @param line - One line as the logger wrote it, newline included.
   * @remarks Never throws, so logging never fails the code that logs. A line
   * that cannot be appended is lost from the files, and the first such
   * failure is reported on standard error. The line is in the file once this
   * returns, so a line logged just before the process ends is kept.
   */
  public write(line: string): void {
    this.#standardOutput.write(line)
    const now = new Date()
    try {
      createLogsDirectory(this.#logsDirectoryPath)
      appendFileSync(
        join(this.#logsDirectoryPath, formatLogFileName(now)),
        line,
        { mode: 0o600 }
      )
    } catch (error) {
      this.#fileFailureReporter.reportFailure(error)
    }
  }
}

/**
 * Logs what Node reports about the backend process: the uncaught failure that
 * is ending it, at level `fatal`, and each warning, at level `warn`.
 *
 * Node emits `uncaughtExceptionMonitor` for an uncaught exception and for an
 * unhandled rejection, including a failure of the entry point's top level,
 * such as an unreadable prompt file, a database that cannot be opened, or a
 * port already in use. Its line carries the failure in `err` and Node's
 * `origin` of it. Node emits `warning` for each process warning, such as a
 * deprecation, and its line carries the warning in `err`. Both listeners only
 * observe: Node still prints the failure or the warning on standard error,
 * and ends the process after an uncaught failure, as it would without them.
 *
 * @param backendProcess - The backend process, whose
 * `uncaughtExceptionMonitor` and `warning` events are logged; borrowed.
 * @param logger - The backend's logger; borrowed. Its destination must write
 * synchronously, as {@link BackendLogDestination} does, for the fatal line to
 * be written before the process ends.
 * @remarks Call once per process, as soon as the logger exists, so a failure
 * of anything after it is logged. A failure before the call, such as
 * `LYS_HOME` not set, has no log line, and Node reports it on standard error
 * only. Calling again adds a second pair of listeners, which logs each
 * failure and warning a second time.
 */
export function registerProcessLogging(
  backendProcess: EventEmitter,
  logger: FastifyBaseLogger
): void {
  backendProcess.on(
    "uncaughtExceptionMonitor",
    (failure: unknown, origin: NodeJS.UncaughtExceptionOrigin) => {
      logger.fatal(
        { err: failure, origin },
        "The Lys backend is stopping on a failure nothing caught"
      )
    }
  )
  backendProcess.on("warning", (warning: Error) => {
    logger.warn({ err: warning }, "Node reported a warning")
  })
}

/**
 * Keeps the backend running when writing to its standard output or standard
 * error fails, such as on a full disk or when the reader of a pipe has exited.
 *
 * A line that cannot be written is lost. Node keeps the process's standard
 * streams open after a failure, so later lines are written again once writing
 * works, as when space has been freed on a full disk; after a pipe's reader
 * has exited, every later line fails too. The first failure of each stream is
 * reported on the other stream, and later failures of that stream are not, so
 * two failing streams cannot report each other's failures without end.
 *
 * @param standardOutput - The backend's standard output, which receives its
 * log lines; borrowed from the process.
 * @param standardError - The backend's standard error, which receives Node's
 * own messages, such as a crash trace; borrowed from the process.
 * @remarks Call once per process, before anything is written. The listeners
 * stay registered for the life of the process; calling again adds a second
 * pair, which reports each stream's first failure a second time.
 */
export function registerOutputFailureListeners(
  standardOutput: Writable,
  standardError: Writable
): void {
  const standardOutputReporter = new OutputFailureReporter(
    "standard output",
    standardError
  )
  const standardErrorReporter = new OutputFailureReporter(
    "standard error",
    standardOutput
  )
  standardOutput.on("error", (error: Error) => {
    standardOutputReporter.reportFailure(error)
  })
  standardError.on("error", (error: Error) => {
    standardErrorReporter.reportFailure(error)
  })
}

/**
 * Owns whether the failure of one backend output, a standard stream or the
 * log file, has been reported, and reports its first failure on another
 * output.
 *
 * @remarks Borrows the report output and never ends or closes it. Concurrency
 * model: single-owner, on the event loop, called from the failed output's
 * `error` events.
 */
class OutputFailureReporter {
  /** Output whose failures this reporter reports. */
  readonly #failedOutputName: BackendOutputName
  /** Output that receives the report; borrowed. */
  readonly #reportOutput: Writable
  /** Whether the first failure has been reported; never reset. */
  #isFailureReported = false

  /**
   * Creates a reporter that has reported nothing yet.
   *
   * @param failedOutputName - Output whose failures it reports.
   * @param reportOutput - Output that receives the one-line report; borrowed.
   */
  public constructor(
    failedOutputName: BackendOutputName,
    reportOutput: Writable
  ) {
    this.#failedOutputName = failedOutputName
    this.#reportOutput = reportOutput
  }

  /**
   * Reports a failure of the output on the report output, unless a failure
   * has already been reported.
   *
   * @param failure - Failure the output reported or the write threw; its
   * message is reported, or the value itself when it is not an `Error`.
   * @remarks A report the report output cannot write is lost, and that output
   * reports the failure through its own `error` event.
   */
  public reportFailure(failure: unknown): void {
    if (this.#isFailureReported) {
      return
    }
    this.#isFailureReported = true
    const reason = failure instanceof Error ? failure.message : String(failure)
    this.#reportOutput.write(
      `The Lys backend could not write to its ${this.#failedOutputName}, so what it writes there is lost while writing fails: ${reason}\n`
    )
  }
}
