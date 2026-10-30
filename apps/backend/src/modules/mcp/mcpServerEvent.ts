import type { McpServerFailure } from "@lys/protocol"
import type { McpRequestFailure } from "./mcpError"

/**
 * Something about the MCP servers that no caller observes, reported for the
 * log.
 *
 * @remarks No event carries a command, an argument, an environment
 * variable, a URL, or a header. An error an event carries, which the SDK or
 * Node threw, can name a remote server's host or hold the text of its HTTP
 * error answer; a command's failure to start is never carried as an error,
 * because Node's error for it holds the arguments.
 */
export type McpServerEvent =
  | Readonly<{
      /** The `mcp` settings group failed its rules; the servers are kept. */
      kind: "settings-invalid"
      /** Each failed rule as `<path>: <rule>`. */
      problems: readonly string[]
    }>
  | Readonly<{
      /** The settings file could not be read; the servers are kept. */
      kind: "settings-unreadable"
    }>
  | Readonly<{
      /** A server connected and its tools were read. */
      kind: "connected"
      /** Name of the server. */
      serverName: string
      /** Tools listed for it. */
      toolCount: number
      /** Tools read but not listed. */
      skippedToolCount: number
      /** Whether it has more tools than the backend reads. */
      isToolListCut: boolean
    }>
  | Readonly<{
      /** A server could not be connected. */
      kind: "opening-failed"
      /** Name of the server. */
      serverName: string
      /** Why, as the server list reports it. */
      reason: McpServerFailure
      /** What the failure was. */
      failure: McpRequestFailure
      /** What was thrown, when Lys could not tell what it was. */
      unknownError: unknown
    }>
  | Readonly<{
      /** A connected server's process exited or its connection ended. */
      kind: "connection-closed"
      /** Name of the server. */
      serverName: string
    }>
  | Readonly<{
      /** The SDK reported a failure outside any request, such as a bad message. */
      kind: "connection-error"
      /** Name of the server. */
      serverName: string
      /** The SDK's error. */
      error: Error
    }>
  | Readonly<{
      /** A stdio server wrote one line to its standard error. */
      kind: "server-log-line"
      /** Name of the server. */
      serverName: string
      /** The line, cut to a bound. */
      line: string
    }>
  | Readonly<{
      /**
       * An HTTP server did not end its session when its connection closed
       * and asked it to; the close went on, and the server ends the session
       * at its own time limit.
       */
      kind: "session-end-failed"
      /** Name of the server. */
      serverName: string
      /** Why: an HTTP error of the answer's status, or what was thrown. */
      error: unknown
    }>
  | Readonly<{
      /** Closing a server's connection failed. */
      kind: "close-failed"
      /** Name of the server. */
      serverName: string
      /** Why. */
      error: unknown
    }>
  | Readonly<{
      /** A tool call failed before it was sent to the server. */
      kind: "tool-call-not-sent"
      /** Name of the server. */
      serverName: string
      /** Name the server calls the tool by. */
      serverToolName: string
      /**
       * Why: the server is not connected when the call runs, which includes
       * a server the settings no longer name, or the connected server no
       * longer lists the tool under the name it was offered by.
       */
      reason: "server-not-connected" | "tool-no-longer-listed"
    }>
  | Readonly<{
      /** A tool call failed before the server returned a result. */
      kind: "tool-call-failed"
      /** Name of the server. */
      serverName: string
      /** Name the server calls the tool by. */
      serverToolName: string
      /** What the failure was. */
      failure: McpRequestFailure
      /** What was thrown, when Lys could not tell what it was. */
      unknownError: unknown
    }>
