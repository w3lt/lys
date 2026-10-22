import type { Writable } from "node:stream"
import type {
  FastifyLoggerOptions,
  FastifyServerOptions,
  LogLevel
} from "fastify"

/**
 * Options of a Fastify application's own logger, in the form
 * `Fastify({ logger })` accepts them.
 */
export type BackendLoggerOptions = Exclude<
  FastifyServerOptions["logger"],
  boolean | undefined
>

/** The `level` field of a log line, holding the level's name. */
type LogLevelField = Readonly<{
  /** Name of the line's level, such as `info` or `error`. */
  level: string
}>

/** Name of a backend process output, as its failure report states it. */
type BackendOutputName = "standard output" | "standard error"

/**
 * Builds the options of a backend application's logger.
 *
 * Each line is one JSON object whose `level` is the level's name, such as
 * `"info"`, and whose `time` is the UTC ISO-8601 time of the line. A request's
 * lines carry its full URL, query string included, such as a history search,
 * and a request for a route that does not exist gets a line of its own.
 *
 * @param level - Lowest level the logger writes; lines below it are dropped.
 * @param destination - Receives each line; owned by the caller, which handles
 * its write failures. The logger never ends or closes it.
 * @returns New logger options for `Fastify({ logger })`.
 */
export function buildBackendLoggerOptions(
  level: LogLevel,
  destination: NonNullable<FastifyLoggerOptions["stream"]>
): BackendLoggerOptions {
  const formatters = Object.freeze({ level: buildLogLevelField })
  return {
    level,
    formatters,
    timestamp: formatLogTimeField,
    stream: destination
  }
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
 * Owns whether the failure of one backend output has been reported, and
 * reports its first failure on another output.
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
   * @param error - Failure the output reported.
   * @remarks A report the report output cannot write is lost, and that output
   * reports the failure through its own `error` event.
   */
  public reportFailure(error: Error): void {
    if (this.#isFailureReported) {
      return
    }
    this.#isFailureReported = true
    this.#reportOutput.write(
      `The Lys backend could not write to its ${this.#failedOutputName}, so what it writes there is lost while writing fails: ${error.message}\n`
    )
  }
}
