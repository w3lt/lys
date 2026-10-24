import { SdkHttpError } from "@modelcontextprotocol/client"
import type { FastifyBaseLogger } from "fastify"
import type { McpRequestFailure } from "./mcpError"
import type { McpServerEvent } from "./mcpServerEvent"
import { MAXIMUM_SERVER_LOG_LINE_LENGTH } from "./mcpServerLogLines"

/** An event about reading the `mcp` settings group. */
type McpSettingsEvent = Extract<
  McpServerEvent,
  { kind: "settings-invalid" | "settings-unreadable" }
>

/** An event about one server's connection. */
type McpConnectionEvent = Extract<
  McpServerEvent,
  {
    kind:
      | "connected"
      | "connection-closed"
      | "connection-error"
      | "server-log-line"
      | "close-failed"
  }
>

/** A failed opening or tool call. */
type McpRequestFailureEvent = Extract<
  McpServerEvent,
  { kind: "opening-failed" | "tool-call-failed" }
>

/** Most causes of a thrown error an entry describes. */
const MAXIMUM_LOGGED_CAUSE_DEPTH = 4

/**
 * What an entry logs as `err`: a thrown text, or the description of a thrown
 * value, each text cut to {@link MAXIMUM_SERVER_LOG_LINE_LENGTH} characters.
 */
type LoggedError =
  | string
  | Readonly<{
      /** Constructor name of an error, or `typeof` of another value. */
      type: string
      /** Message of an error other than an HTTP error. */
      message?: string
      /** Stack of an error other than an HTTP error. */
      stack?: string
      /** Code of an HTTP error, or a string code such as `ECONNREFUSED`. */
      code?: string
      /** Status of an HTTP error. */
      status?: number
      /** Description of the error's cause. */
      cause?: LoggedError
    }>

/**
 * Options of the child logger that writes MCP entries: its `err` serializer
 * replaces pino's, which writes every field of an error, such as the whole
 * answer an HTTP error holds.
 */
const MCP_LOG_OPTIONS = Object.freeze({
  serializers: Object.freeze({
    err: (thrown: unknown): LoggedError => describeThrown(thrown, 0)
  })
})

/**
 * Writes one MCP server event to the backend log.
 *
 * @param logger - Backend logger, borrowed for the call.
 * @param event - Event the registry reported.
 * @remarks Each entry names the server as `mcpServer`. Failures Lys can tell
 * apart and ended connections are warnings; a failure Lys cannot tell
 * apart, and a failed close, are errors with what was thrown; a server's
 * own log lines and a connection are information. No entry holds a
 * setting. An entry's `err` describes what was thrown: its type, message,
 * stack, string code, and at most 4 causes, each text cut to 2,000
 * characters; an HTTP error is described only by its code and status,
 * because its message holds the server's answer. A server's message of a
 * refused call is cut the same way. A message or stack can still name a
 * remote server's host.
 */
export function logMcpServerEvent(
  parentLogger: FastifyBaseLogger,
  event: McpServerEvent
): void {
  const logger = parentLogger.child({}, MCP_LOG_OPTIONS)
  switch (event.kind) {
    case "settings-invalid":
    case "settings-unreadable":
      logSettingsEvent(logger, event)
      return
    case "connected":
    case "connection-closed":
    case "connection-error":
    case "server-log-line":
    case "close-failed":
      logConnectionEvent(logger, event)
      return
    case "opening-failed":
    case "tool-call-failed":
      logRequestFailureEvent(logger, event)
      return
  }
}

/**
 * Writes one event about reading the `mcp` settings group, as a warning.
 *
 * @param logger - Backend logger.
 * @param event - Settings event.
 */
function logSettingsEvent(
  logger: FastifyBaseLogger,
  event: McpSettingsEvent
): void {
  if (event.kind === "settings-unreadable") {
    logger.warn(
      "The settings file could not be read; the MCP servers applied before are kept"
    )
    return
  }
  logger.warn(
    { problems: event.problems },
    "The mcp settings group fails its rules; the MCP servers applied before are kept"
  )
}

/**
 * Writes one event about a server's connection.
 *
 * @param logger - Backend logger.
 * @param event - Connection event.
 */
function logConnectionEvent(
  logger: FastifyBaseLogger,
  event: McpConnectionEvent
): void {
  const fields = { mcpServer: event.serverName }
  switch (event.kind) {
    case "connected":
      logger.info(
        {
          ...fields,
          toolCount: event.toolCount,
          skippedToolCount: event.skippedToolCount,
          isToolListCut: event.isToolListCut
        },
        "MCP server connected"
      )
      return
    case "connection-closed":
      logger.warn(
        fields,
        "MCP server connection ended; it can be reconnected in Settings"
      )
      return
    case "connection-error":
      logger.warn(
        { ...fields, err: event.error },
        "MCP server connection reported an error"
      )
      return
    case "server-log-line":
      logger.info({ ...fields, line: event.line }, "MCP server log line")
      return
    case "close-failed":
      logger.error(
        { ...fields, err: event.error },
        "Closing an MCP server connection failed"
      )
      return
  }
}

/**
 * Writes one failed opening or tool call.
 *
 * @param logger - Backend logger.
 * @param event - Failure event.
 */
function logRequestFailureEvent(
  logger: FastifyBaseLogger,
  event: McpRequestFailureEvent
): void {
  if (event.kind === "opening-failed") {
    logFailure(
      logger,
      {
        mcpServer: event.serverName,
        reason: event.reason,
        failure: boundFailure(event.failure)
      },
      event.unknownError,
      "MCP server could not be connected"
    )
    return
  }
  logFailure(
    logger,
    {
      mcpServer: event.serverName,
      tool: event.serverToolName,
      failure: boundFailure(event.failure)
    },
    event.unknownError,
    "MCP tool call failed before the server returned a result"
  )
}

/**
 * Writes one failure: a warning when Lys could tell what it was, else an
 * error with what was thrown.
 *
 * @param logger - Backend logger.
 * @param fields - Fields that describe the failure.
 * @param unknownError - What was thrown when Lys could not tell what it
 * was; otherwise undefined.
 * @param message - Log message.
 */
function logFailure(
  logger: FastifyBaseLogger,
  fields: Readonly<Record<string, unknown>>,
  unknownError: unknown,
  message: string
): void {
  if (unknownError === undefined) logger.warn(fields, message)
  else logger.error({ ...fields, err: unknownError }, message)
}

/**
 * Bounds the server's text a failure holds.
 *
 * @param failure - Failure of an opening or a call.
 * @returns The same failure, except that a refusal's message is cut to
 * {@link MAXIMUM_SERVER_LOG_LINE_LENGTH} characters.
 */
function boundFailure(failure: McpRequestFailure): McpRequestFailure {
  if (failure.kind !== "refused") return failure
  return { kind: "refused", message: cutText(failure.message) }
}

/**
 * Describes what was thrown within the bounds of an entry.
 *
 * @param thrown - Thrown value or cause.
 * @param causeDepth - Causes already followed to reach it.
 * @returns A cut text for a thrown text; the code and status of an HTTP
 * error; the description of another error; or the `typeof` of another value.
 */
function describeThrown(thrown: unknown, causeDepth: number): LoggedError {
  if (thrown instanceof SdkHttpError)
    return { type: "SdkHttpError", code: thrown.code, status: thrown.status }
  if (thrown instanceof Error) return describeError(thrown, causeDepth)
  if (typeof thrown === "string") return cutText(thrown)
  return { type: typeof thrown }
}

/**
 * Describes an error other than an HTTP error.
 *
 * @param error - Thrown error or cause.
 * @param causeDepth - Causes already followed to reach it.
 * @returns Its constructor name, cut message and stack, string code, and the
 * description of its cause until {@link MAXIMUM_LOGGED_CAUSE_DEPTH} causes
 * were followed.
 */
function describeError(error: Error, causeDepth: number): LoggedError {
  const hasCause =
    error.cause !== undefined && causeDepth < MAXIMUM_LOGGED_CAUSE_DEPTH
  const code = "code" in error ? error.code : undefined
  return {
    type: error.constructor.name,
    message: cutText(error.message),
    ...(error.stack === undefined ? {} : { stack: cutText(error.stack) }),
    ...(typeof code === "string" ? { code: cutText(code) } : {}),
    ...(hasCause ? { cause: describeThrown(error.cause, causeDepth + 1) } : {})
  }
}

/**
 * Cuts a text to {@link MAXIMUM_SERVER_LOG_LINE_LENGTH} characters.
 *
 * @param text - Text that may come from a server.
 * @returns Its first characters.
 */
function cutText(text: string): string {
  return text.slice(0, MAXIMUM_SERVER_LOG_LINE_LENGTH)
}
