import type { Writable } from "node:stream"
import type {
  FastifyLoggerOptions,
  FastifyRequest,
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

/** The `req` object of a request's log lines. */
type LoggedRequest = Readonly<{
  /** HTTP method of the request. */
  method: string
  /** Path the request asked for, without its query string. */
  url: string
  /** Value of the request's `Host` header. */
  host: string
  /** Address the request came from. */
  remoteAddress: string
  /** Port the request came from; absent once its connection has closed. */
  remotePort?: number
}>

/** Name of a backend process output, as its failure report states it. */
type BackendOutputName = "standard output" | "standard error"

/**
 * Builds the options of a backend application's logger.
 *
 * Each line is one JSON object whose `level` is the level's name, such as
 * `"info"`, and whose `time` is the UTC ISO-8601 time of the line. A request's
 * lines describe it by method, path, host, and remote address and port; the
 * query string is left out, because it can carry what the person typed, such
 * as a history search.
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
  const serializers = Object.freeze({ req: buildLoggedRequest })
  return {
    level,
    formatters,
    serializers,
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
 * Builds the `req` object that a request's log lines carry.
 *
 * @param request - Request being logged.
 * @returns The request's method, path without its query string, host, and
 * remote address and port.
 */
function buildLoggedRequest(request: FastifyRequest): LoggedRequest {
  const loggedRequest = {
    method: request.method,
    url: formatRequestPath(request.url),
    host: request.host,
    remoteAddress: request.ip
  }
  const remotePort = request.socket.remotePort
  return Object.freeze(
    remotePort === undefined ? loggedRequest : { ...loggedRequest, remotePort }
  )
}

/**
 * Formats a request URL for the log as its path alone.
 *
 * @param url - Path and query string the request asked for.
 * @returns The part before the first `?`, or the whole URL when it has no
 * query string.
 */
function formatRequestPath(url: string): string {
  const queryStart = url.indexOf("?")
  return queryStart === -1 ? url : url.slice(0, queryStart)
}

/**
 * Keeps the backend running when writing to its standard output or standard
 * error fails, such as on a full disk or when the reader of a pipe has exited.
 *
 * A failed stream is closed by Node and drops whatever is written to it later,
 * so the backend loses that output until it restarts. The failure is reported
 * once on the other stream. A report that cannot be written either is dropped,
 * so a failure never leads to more than one report per stream.
 *
 * @param standardOutput - The backend's standard output, which receives its
 * log lines; borrowed from the process.
 * @param standardError - The backend's standard error, which receives Node's
 * own messages, such as a crash trace; borrowed from the process.
 * @remarks Call once per process, before anything is written. The listeners
 * stay registered for the life of the process; calling again adds a second
 * pair, which reports each failure a second time.
 */
export function registerOutputFailureListeners(
  standardOutput: Writable,
  standardError: Writable
): void {
  standardOutput.on("error", (error: Error) => {
    handleOutputError("standard output", error, standardError)
  })
  standardError.on("error", (error: Error) => {
    handleOutputError("standard error", error, standardOutput)
  })
}

/**
 * Reports on another output that writing to one of the backend's outputs
 * failed.
 *
 * @param failedOutputName - Output whose write failed.
 * @param error - Failure that output reported.
 * @param reportOutput - Output that receives the one-line report; a report it
 * cannot write is dropped.
 */
function handleOutputError(
  failedOutputName: BackendOutputName,
  error: Error,
  reportOutput: Writable
): void {
  reportOutput.write(
    `The Lys backend could not write to its ${failedOutputName}, so it drops what it writes there until it restarts: ${error.message}\n`
  )
}
