import { SdkErrorCode, SdkHttpError } from "@modelcontextprotocol/client"
import { describe, expect, it } from "vitest"
import { createBackendLogger } from "../../../../src/log"
import { handleMcpServerEvent } from "../../../../src/modules/mcp/mcpServerEventLog"
import type { McpServerEvent } from "../../../../src/modules/mcp/mcpServerEvent"
import {
  CapturedLogDestination,
  type CapturedLogRecord
} from "../../support/fastifyTestApp"

/** Most characters of a server-supplied text an MCP entry keeps. */
const LOGGED_TEXT_LENGTH = 2000

/**
 * Builds the HTTP error the SDK reports for an error status, which holds the
 * server's whole answer.
 *
 * @param status - HTTP status of the answer.
 * @param answer - Text of the answer.
 * @returns The SDK's error.
 */
function buildHttpError(status: number, answer: string): SdkHttpError {
  return new SdkHttpError(
    SdkErrorCode.ClientHttpNotImplemented,
    `Error POSTing to endpoint: ${answer}`,
    { status, statusText: "Error", text: answer }
  )
}

/** Fields every backend log line has, whatever was logged. */
const COMMON_FIELDS = ["time", "pid", "hostname"] as const

/**
 * Logs one event with the backend's logger and reads the one line written.
 *
 * @param event - Event to log.
 * @returns The line's fields, without the time and process fields every
 * line has.
 * @throws When the logger wrote no line or more than one.
 */
function logEvent(event: McpServerEvent): Record<string, unknown> {
  const destination = new CapturedLogDestination()
  handleMcpServerEvent(createBackendLogger(destination), event)
  const records = destination.records
  if (records.length !== 1)
    throw new Error(`Expected one log line, got ${records.length}`)
  return withoutCommonFields(records[0] as CapturedLogRecord)
}

/**
 * Copies a log record without the fields every line has.
 *
 * @param record - Parsed log line.
 * @returns The other fields.
 */
function withoutCommonFields(
  record: CapturedLogRecord
): Record<string, unknown> {
  const fields: Record<string, unknown> = { ...record }
  for (const name of COMMON_FIELDS) delete fields[name]
  return fields
}

describe("handleMcpServerEvent", () => {
  it("warns of an invalid settings group with its problems", () => {
    expect(
      logEvent({
        kind: "settings-invalid",
        problems: ["servers.0.url: A URL starts with https://."]
      })
    ).toEqual({
      level: "warn",
      problems: ["servers.0.url: A URL starts with https://."],
      msg: "The mcp settings group fails its rules; the MCP servers applied before are kept"
    })
  })

  it("warns of an unreadable settings file", () => {
    expect(logEvent({ kind: "settings-unreadable" })).toEqual({
      level: "warn",
      msg: "The settings file could not be read; the MCP servers applied before are kept"
    })
  })

  it("logs a connected server with its tool counts", () => {
    expect(
      logEvent({
        kind: "connected",
        serverName: "notes",
        toolCount: 3,
        skippedToolCount: 1,
        isToolListCut: false
      })
    ).toEqual({
      level: "info",
      mcpServer: "notes",
      toolCount: 3,
      skippedToolCount: 1,
      isToolListCut: false,
      msg: "MCP server connected"
    })
  })

  it("warns of a failed opening Lys can tell apart, without an error", () => {
    expect(
      logEvent({
        kind: "opening-failed",
        serverName: "notes",
        reason: "unauthorized",
        failure: { kind: "http-status", status: 401 },
        unknownError: undefined
      })
    ).toEqual({
      level: "warn",
      mcpServer: "notes",
      reason: "unauthorized",
      failure: { kind: "http-status", status: 401 },
      msg: "MCP server could not be connected"
    })
  })

  it("logs a failed opening Lys cannot tell apart as an error with what was thrown", () => {
    const fields = logEvent({
      kind: "opening-failed",
      serverName: "notes",
      reason: "protocol-error",
      failure: { kind: "unknown" },
      unknownError: new RangeError("odd failure")
    })

    expect(fields).toEqual({
      level: "error",
      mcpServer: "notes",
      reason: "protocol-error",
      failure: { kind: "unknown" },
      err: expect.objectContaining({
        type: "RangeError",
        message: "odd failure"
      }),
      msg: "MCP server could not be connected"
    })
  })

  it("warns of a connection that ended", () => {
    expect(
      logEvent({ kind: "connection-closed", serverName: "notes" })
    ).toEqual({
      level: "warn",
      mcpServer: "notes",
      msg: "MCP server connection ended; it can be reconnected in Settings"
    })
  })

  it("warns of an error the connection reported, with the error", () => {
    expect(
      logEvent({
        kind: "connection-error",
        serverName: "notes",
        error: new SyntaxError("Unexpected token")
      })
    ).toEqual({
      level: "warn",
      mcpServer: "notes",
      err: expect.objectContaining({
        type: "SyntaxError",
        message: "Unexpected token"
      }),
      msg: "MCP server connection reported an error"
    })
  })

  it("logs an HTTP error the connection reported by its code and status, without the server's answer", () => {
    const answer = `private answer ${"x".repeat(3_000_000)}`

    const fields = logEvent({
      kind: "connection-error",
      serverName: "notes",
      error: buildHttpError(500, answer)
    })

    expect(fields).toEqual({
      level: "warn",
      mcpServer: "notes",
      err: {
        type: "SdkHttpError",
        code: SdkErrorCode.ClientHttpNotImplemented,
        status: 500
      },
      msg: "MCP server connection reported an error"
    })
  })

  it("cuts the message and the stack of an error the connection reported to 2,000 characters each", () => {
    const error = new Error("y".repeat(5000))

    const fields = logEvent({
      kind: "connection-error",
      serverName: "notes",
      error
    })

    expect(fields["err"]).toEqual({
      type: "Error",
      message: "y".repeat(LOGGED_TEXT_LENGTH),
      stack: (error.stack ?? "").slice(0, LOGGED_TEXT_LENGTH)
    })
  })

  it("keeps at most 4 causes of an error", () => {
    let error = new Error("first")
    for (const message of ["second", "third", "fourth", "fifth", "sixth"])
      error = new Error(message, { cause: error })

    const fields = logEvent({
      kind: "close-failed",
      serverName: "notes",
      error
    })

    expect(fields["err"]).toEqual({
      type: "Error",
      message: "sixth",
      stack: expect.any(String),
      cause: {
        type: "Error",
        message: "fifth",
        stack: expect.any(String),
        cause: {
          type: "Error",
          message: "fourth",
          stack: expect.any(String),
          cause: {
            type: "Error",
            message: "third",
            stack: expect.any(String),
            cause: {
              type: "Error",
              message: "second",
              stack: expect.any(String)
            }
          }
        }
      }
    })
  })

  it("logs an HTTP error among the causes by its code and status, without the server's answer", () => {
    const error = new Error("Opening failed", {
      cause: new TypeError("Request failed", {
        cause: buildHttpError(502, "private answer")
      })
    })

    const fields = logEvent({
      kind: "opening-failed",
      serverName: "notes",
      reason: "protocol-error",
      failure: { kind: "unknown" },
      unknownError: error
    })

    expect(fields["err"]).toEqual({
      type: "Error",
      message: "Opening failed",
      stack: expect.any(String),
      cause: {
        type: "TypeError",
        message: "Request failed",
        stack: expect.any(String),
        cause: {
          type: "SdkHttpError",
          code: SdkErrorCode.ClientHttpNotImplemented,
          status: 502
        }
      }
    })
    expect(JSON.stringify(fields)).not.toContain("private answer")
  })

  it("logs a string code of an error, such as a Node system error's", () => {
    const error = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
      address: "127.0.0.1"
    })

    const fields = logEvent({
      kind: "connection-error",
      serverName: "notes",
      error
    })

    expect(fields["err"]).toEqual({
      type: "Error",
      message: "connect ECONNREFUSED",
      stack: expect.any(String),
      code: "ECONNREFUSED"
    })
  })

  it("logs only the type of a thrown value that is neither an error nor a text", () => {
    const fields = logEvent({
      kind: "close-failed",
      serverName: "notes",
      error: { answer: "private answer" }
    })

    expect(fields["err"]).toEqual({ type: "object" })
  })

  it("cuts a thrown text to 2,000 characters", () => {
    const fields = logEvent({
      kind: "close-failed",
      serverName: "notes",
      error: "t".repeat(5000)
    })

    expect(fields["err"]).toBe("t".repeat(LOGGED_TEXT_LENGTH))
  })

  it("cuts the server's message of a refused call to 2,000 characters", () => {
    const fields = logEvent({
      kind: "tool-call-failed",
      serverName: "notes",
      serverToolName: "lookup",
      failure: { kind: "refused", message: "z".repeat(5000) },
      unknownError: undefined
    })

    expect(fields["failure"]).toEqual({
      kind: "refused",
      message: "z".repeat(LOGGED_TEXT_LENGTH)
    })
  })

  it("logs a server's log line as information", () => {
    expect(
      logEvent({
        kind: "server-log-line",
        serverName: "notes",
        line: "listening on stdio"
      })
    ).toEqual({
      level: "info",
      mcpServer: "notes",
      line: "listening on stdio",
      msg: "MCP server log line"
    })
  })

  it("logs a failed close as an error with what was thrown", () => {
    expect(
      logEvent({
        kind: "close-failed",
        serverName: "notes",
        error: new Error("kill EPERM")
      })
    ).toEqual({
      level: "error",
      mcpServer: "notes",
      err: expect.objectContaining({ type: "Error", message: "kill EPERM" }),
      msg: "Closing an MCP server connection failed"
    })
  })

  it("warns of a tool call that was not sent, with its reason", () => {
    expect(
      logEvent({
        kind: "tool-call-not-sent",
        serverName: "notes",
        serverToolName: "lookup",
        reason: "server-not-connected"
      })
    ).toEqual({
      level: "warn",
      mcpServer: "notes",
      tool: "lookup",
      reason: "server-not-connected",
      msg: "MCP tool call was not sent to the server"
    })
    expect(
      logEvent({
        kind: "tool-call-not-sent",
        serverName: "notes",
        serverToolName: "lookup",
        reason: "tool-no-longer-listed"
      })
    ).toEqual({
      level: "warn",
      mcpServer: "notes",
      tool: "lookup",
      reason: "tool-no-longer-listed",
      msg: "MCP tool call was not sent to the server"
    })
  })

  it("warns of a failed tool call Lys can tell apart, without an error", () => {
    expect(
      logEvent({
        kind: "tool-call-failed",
        serverName: "notes",
        serverToolName: "lookup",
        failure: { kind: "timed-out" },
        unknownError: undefined
      })
    ).toEqual({
      level: "warn",
      mcpServer: "notes",
      tool: "lookup",
      failure: { kind: "timed-out" },
      msg: "MCP tool call failed before the server returned a result"
    })
  })

  it("logs a failed tool call Lys cannot tell apart as an error with what was thrown", () => {
    expect(
      logEvent({
        kind: "tool-call-failed",
        serverName: "notes",
        serverToolName: "lookup",
        failure: { kind: "unknown" },
        unknownError: "a thrown text"
      })
    ).toEqual({
      level: "error",
      mcpServer: "notes",
      tool: "lookup",
      failure: { kind: "unknown" },
      err: "a thrown text",
      msg: "MCP tool call failed before the server returned a result"
    })
  })
})
