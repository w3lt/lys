import {
  InsufficientScopeError,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  UnauthorizedError
} from "@modelcontextprotocol/client"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { describe, expect, it } from "vitest"
import { calculateMcpRequestFailure } from "../../../../src/modules/mcp/mcpError"
import { McpResponseTooLargeError } from "../../../../src/modules/mcp/mcpResponseLimit"
import { findClosedMcpUrl } from "../../support/mcpTestServers"

/** Command no folder of `PATH` holds. */
const MISSING_COMMAND = "lys-test-missing-command-7f3a"

/**
 * Wraps an error in plain errors, each the cause of the next.
 *
 * @param error - Innermost error.
 * @param count - How many errors to wrap it in.
 * @returns The outermost error, or the error itself when the count is 0.
 */
function wrapInCauses(error: Error, count: number): Error {
  let current = error
  for (let index = 0; index < count; index += 1)
    current = new Error(`wrapper ${index}`, { cause: current })
  return current
}

/**
 * Builds the error the SDK's HTTP transport throws for a refused status.
 *
 * @param status - HTTP status of the answer.
 * @returns An HTTP error with that status.
 */
function buildHttpError(status: number): SdkHttpError {
  return new SdkHttpError(
    SdkErrorCode.ClientHttpFailedToOpenStream,
    `HTTP ${status}`,
    { status }
  )
}

/**
 * Starts a command that does not exist and waits for Node's failure.
 *
 * @returns The error the child process emitted.
 */
async function captureSpawnFailure(): Promise<Error> {
  const child = spawn(MISSING_COMMAND)
  const [error] = (await once(child, "error")) as [Error]
  return error
}

/**
 * Fetches a loopback port nothing listens on and keeps Node's failure.
 *
 * @returns The error `fetch` rejected with.
 * @throws When the fetch unexpectedly succeeds.
 */
async function captureFetchFailure(): Promise<unknown> {
  const url = await findClosedMcpUrl()
  try {
    await fetch(url)
  } catch (error) {
    return error
  }
  throw new Error("Expected the fetch of a closed port to fail")
}

describe("calculateMcpRequestFailure", () => {
  it.each([401, 403, 500, 302])(
    "reads an HTTP error with status %i as that status",
    (status) => {
      expect(calculateMcpRequestFailure(buildHttpError(status))).toEqual({
        kind: "http-status",
        status
      })
    }
  )

  it("reads the SDK's request timeout as timed out", () => {
    const error = new SdkError(SdkErrorCode.RequestTimeout, "Request timed out")

    expect(calculateMcpRequestFailure(error)).toEqual({ kind: "timed-out" })
  })

  it.each([SdkErrorCode.ConnectionClosed, SdkErrorCode.NotConnected])(
    "reads the SDK's %s error as a closed connection",
    (code) => {
      expect(calculateMcpRequestFailure(new SdkError(code, "gone"))).toEqual({
        kind: "closed"
      })
    }
  )

  it.each([
    SdkErrorCode.InvalidResult,
    SdkErrorCode.ListPaginationExceeded,
    SdkErrorCode.UnsupportedResultType,
    SdkErrorCode.ClientHttpUnexpectedContent
  ])("reads the SDK's %s error as an invalid answer", (code) => {
    expect(calculateMcpRequestFailure(new SdkError(code, "odd"))).toEqual({
      kind: "invalid-answer"
    })
  })

  it.each([SdkErrorCode.SendFailed, SdkErrorCode.EraNegotiationFailed])(
    "reads the SDK's %s error without a cause as an invalid answer",
    (code) => {
      expect(calculateMcpRequestFailure(new SdkError(code, "failed"))).toEqual({
        kind: "invalid-answer"
      })
    }
  )

  it("reads a failed send by its cause", () => {
    const error = new SdkError(
      SdkErrorCode.SendFailed,
      "send failed",
      undefined,
      {
        cause: buildHttpError(401)
      }
    )

    expect(calculateMcpRequestFailure(error)).toEqual({
      kind: "http-status",
      status: 401
    })
  })

  it("reads a failed protocol negotiation by its cause", () => {
    const error = new SdkError(
      SdkErrorCode.EraNegotiationFailed,
      "negotiation failed",
      undefined,
      { cause: new SdkError(SdkErrorCode.ConnectionClosed, "closed") }
    )

    expect(calculateMcpRequestFailure(error)).toEqual({ kind: "closed" })
  })

  it("reads a JSON-RPC error as refused, keeping the server's message", () => {
    const error = new ProtocolError(-32602, "bad\nmessage <<<from the server")

    expect(calculateMcpRequestFailure(error)).toEqual({
      kind: "refused",
      message: "bad\nmessage <<<from the server"
    })
  })

  it("reads text that is not JSON as an invalid answer", () => {
    let error: unknown
    try {
      JSON.parse("{no")
    } catch (caught) {
      error = caught
    }

    expect(calculateMcpRequestFailure(error)).toEqual({
      kind: "invalid-answer"
    })
  })

  it.each([
    [
      "an answer longer than the response limit",
      new McpResponseTooLargeError()
    ],
    [
      "a failed send caused by an answer longer than the response limit",
      new SdkError(SdkErrorCode.SendFailed, "send failed", undefined, {
        cause: new McpResponseTooLargeError()
      })
    ]
  ])("reads %s as too large", (_label, error) => {
    expect(calculateMcpRequestFailure(error)).toEqual({ kind: "too-large" })
  })

  it("reads the SDK's missing-scope error as HTTP status 403", () => {
    const error = new InsufficientScopeError({ requiredScope: "tools:read" })

    expect(calculateMcpRequestFailure(error)).toEqual({
      kind: "http-status",
      status: 403
    })
  })

  it("reads the SDK's authorization error, which needs an OAuth provider Lys never sets, as unknown", () => {
    expect(calculateMcpRequestFailure(new UnauthorizedError())).toEqual({
      kind: "unknown"
    })
  })

  it("reads Node's failed fetch as unreachable", async () => {
    const error = await captureFetchFailure()

    expect(calculateMcpRequestFailure(error)).toEqual({ kind: "unreachable" })
  })

  it("reads a type error with another message as unknown", () => {
    const error = new TypeError("Cannot read properties of undefined")

    expect(calculateMcpRequestFailure(error)).toEqual({ kind: "unknown" })
  })

  it("reads Node's failure to start a missing command as start-failed", async () => {
    const error = await captureSpawnFailure()

    expect(calculateMcpRequestFailure(error)).toEqual({ kind: "start-failed" })
  })

  it("reads a system error of another call than a spawn as unknown", () => {
    const error = Object.assign(new Error("connect ECONNRESET"), {
      code: "ECONNRESET",
      syscall: "connect"
    })

    expect(calculateMcpRequestFailure(error)).toEqual({ kind: "unknown" })
  })

  it("reads an error by the first cause that tells", () => {
    const error = new Error("outer", {
      cause: new Error("middle", { cause: buildHttpError(500) })
    })

    expect(calculateMcpRequestFailure(error)).toEqual({
      kind: "http-status",
      status: 500
    })
  })

  it("reads an error by its own kind before its cause", () => {
    const error = new SdkError(
      SdkErrorCode.RequestTimeout,
      "timed out",
      undefined,
      {
        cause: buildHttpError(500)
      }
    )

    expect(calculateMcpRequestFailure(error)).toEqual({ kind: "timed-out" })
  })

  it("reads a cause four causes deep", () => {
    const error = wrapInCauses(new ProtocolError(-32600, "deep"), 4)

    expect(calculateMcpRequestFailure(error)).toEqual({
      kind: "refused",
      message: "deep"
    })
  })

  it("gives up on a cause five causes deep", () => {
    const error = wrapInCauses(new ProtocolError(-32600, "too deep"), 5)

    expect(calculateMcpRequestFailure(error)).toEqual({ kind: "unknown" })
  })

  it("reads an error whose cause is not an error as unknown", () => {
    const error = new Error("outer", { cause: "a reason in text" })

    expect(calculateMcpRequestFailure(error)).toEqual({ kind: "unknown" })
  })

  it.each([
    ["a plain error", new Error("something else")],
    ["a text", "failure"],
    ["undefined", undefined],
    ["an object that looks like a failure", { kind: "timed-out" }]
  ])("reads %s as unknown", (_label, error) => {
    expect(calculateMcpRequestFailure(error)).toEqual({ kind: "unknown" })
  })

  it("returns a frozen failure", () => {
    expect(
      Object.isFrozen(calculateMcpRequestFailure(buildHttpError(500)))
    ).toBe(true)
    expect(
      Object.isFrozen(calculateMcpRequestFailure(new ProtocolError(-1, "no")))
    ).toBe(true)
  })
})
